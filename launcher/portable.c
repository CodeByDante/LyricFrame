#define WIN32_LEAN_AND_MEAN

#include <windows.h>
#include <bcrypt.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <wchar.h>

#include "miniz.h"

enum { PATH_CAPACITY = 4096, FOOTER_SIZE = 16 };

typedef struct {
    ULONGLONG started;
    HWND window;
    BOOL cancelled;
} Progress;

typedef struct {
    HANDLE file;
    Progress *progress;
} Output;

static LRESULT CALLBACK progress_proc(HWND window, UINT message, WPARAM wparam, LPARAM lparam) {
    if (message == WM_CLOSE) {
        Progress *progress = (Progress *)GetWindowLongPtrW(window, GWLP_USERDATA);
        if (progress) progress->cancelled = TRUE;
        ShowWindow(window, SW_HIDE);
        return 0;
    }
    return DefWindowProcW(window, message, wparam, lparam);
}

static HWND show_progress(Progress *progress) {
    HINSTANCE instance = GetModuleHandleW(NULL);
    WNDCLASSW cls = {0};
    cls.lpfnWndProc = progress_proc;
    cls.hInstance = instance;
    cls.hIcon = LoadIconW(instance, MAKEINTRESOURCEW(1));
    cls.hCursor = LoadCursorW(NULL, MAKEINTRESOURCEW(32512));
    cls.hbrBackground = (HBRUSH)(COLOR_WINDOW + 1);
    cls.lpszClassName = L"LyricFramePortableStartup";
    if (!RegisterClassW(&cls)) return NULL;

    int width = 350;
    int height = 112;
    HWND window = CreateWindowExW(0, cls.lpszClassName, L"LyricFrame", WS_CAPTION | WS_SYSMENU,
                                 (GetSystemMetrics(SM_CXSCREEN) - width) / 2,
                                 (GetSystemMetrics(SM_CYSCREEN) - height) / 2,
                                 width, height, NULL, NULL, instance, NULL);
    if (!window) return NULL;

    SetWindowLongPtrW(window, GWLP_USERDATA, (LONG_PTR)progress);
    RECT client;
    GetClientRect(window, &client);
    HWND label = CreateWindowExW(0, L"STATIC", L"Preparando LyricFrame…",
                                WS_CHILD | WS_VISIBLE | SS_CENTER | SS_CENTERIMAGE,
                                0, 0, client.right, client.bottom, window, NULL, instance, NULL);
    if (label) SendMessageW(label, WM_SETFONT, (WPARAM)GetStockObject(DEFAULT_GUI_FONT), TRUE);
    ShowWindow(window, SW_SHOWNOACTIVATE);
    return window;
}

static BOOL continue_extracting(Progress *progress) {
    if (!progress->window && progress->started && GetTickCount64() - progress->started >= 500) {
        progress->started = 0;
        progress->window = show_progress(progress);
    }
    if (progress->window) {
        MSG message;
        while (PeekMessageW(&message, NULL, 0, 0, PM_REMOVE)) {
            TranslateMessage(&message);
            DispatchMessageW(&message);
        }
    }
    return !progress->cancelled;
}

static BOOL locate_zip(FILE *file, mz_zip_archive *zip) {
    if (_fseeki64(file, 0, SEEK_END)) return FALSE;
    int64_t size = _ftelli64(file);
    if (size <= FOOTER_SIZE || _fseeki64(file, -FOOTER_SIZE, SEEK_END)) return FALSE;

    unsigned char footer[FOOTER_SIZE];
    if (fread(footer, 1, sizeof(footer), file) != sizeof(footer) || memcmp(footer + 8, "LYRICZIP", 8)) {
        return FALSE;
    }

    uint64_t zip_size = 0;
    for (unsigned i = 0; i < 8; i++) zip_size |= (uint64_t)footer[i] << (i * 8);
    if (zip_size < 22 || zip_size >= (uint64_t)(size - FOOTER_SIZE)) return FALSE;

    int64_t offset = size - FOOTER_SIZE - (int64_t)zip_size;
    if (_fseeki64(file, offset, SEEK_SET)) return FALSE;
    return mz_zip_reader_init_cfile(zip, file, zip_size, 0) != MZ_FALSE;
}

static BOOL create_workspace(wchar_t *root) {
    wchar_t temp[PATH_CAPACITY];
    DWORD length = GetTempPathW(ARRAYSIZE(temp), temp);
    if (!length || length >= ARRAYSIZE(temp)) return FALSE;

    for (unsigned attempt = 0; attempt < 8; attempt++) {
        unsigned char random[12];
        if (BCryptGenRandom(NULL, random, sizeof(random), BCRYPT_USE_SYSTEM_PREFERRED_RNG) != 0) return FALSE;
        if (swprintf(root, PATH_CAPACITY, L"%lsLyricFrame-%02x%02x%02x%02x%02x%02x%02x%02x%02x%02x%02x%02x",
                     temp, random[0], random[1], random[2], random[3], random[4], random[5],
                     random[6], random[7], random[8], random[9], random[10], random[11]) < 0) return FALSE;
        if (CreateDirectoryW(root, NULL)) return TRUE;
        if (GetLastError() != ERROR_ALREADY_EXISTS) return FALSE;
    }
    return FALSE;
}

static BOOL ordinary_directory(const wchar_t *path) {
    DWORD attributes = GetFileAttributesW(path);
    return attributes != INVALID_FILE_ATTRIBUTES && (attributes & FILE_ATTRIBUTE_DIRECTORY) &&
           !(attributes & FILE_ATTRIBUTE_REPARSE_POINT);
}

static BOOL reserved_name(const wchar_t *name, size_t length) {
    size_t stem = 0;
    while (stem < length && name[stem] != L'.') stem++;
    while (stem && name[stem - 1] == L' ') stem--;

    if (stem == 3) {
        return !_wcsnicmp(name, L"CON", 3) || !_wcsnicmp(name, L"PRN", 3) ||
               !_wcsnicmp(name, L"AUX", 3) || !_wcsnicmp(name, L"NUL", 3);
    }
    if (stem == 4 && (!_wcsnicmp(name, L"COM", 3) || !_wcsnicmp(name, L"LPT", 3))) {
        wchar_t digit = name[3];
        return (digit >= L'0' && digit <= L'9') || digit == L'¹' || digit == L'²' || digit == L'³';
    }
    return (stem == 6 && !_wcsnicmp(name, L"CONIN$", 6)) || (stem == 7 && !_wcsnicmp(name, L"CONOUT$", 7));
}

static BOOL valid_component(const wchar_t *name, size_t length) {
    if (!length || length > 255 || name[length - 1] == L'.' || name[length - 1] == L' ') return FALSE;
    for (size_t i = 0; i < length; i++) {
        if (name[i] < 32 || wcschr(L"\\:<>\"|?*", name[i])) return FALSE;
    }
    return !reserved_name(name, length);
}

static BOOL build_output_path(const wchar_t *root, const char *entry, BOOL directory, wchar_t *path) {
    if (strncmp(entry, "LyricFrame/", sizeof("LyricFrame/") - 1)) return FALSE;
    wchar_t relative[PATH_CAPACITY];
    int length = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, entry, -1, relative, ARRAYSIZE(relative));
    if (!length) return FALSE;
    if (directory && length > 1 && relative[length - 2] == L'/') relative[length - 2] = L'\0';

    wchar_t *component = relative;
    for (wchar_t *position = relative;; position++) {
        if (*position != L'/' && *position) continue;
        if (!valid_component(component, (size_t)(position - component))) return FALSE;
        if (!*position) break;
        *position = L'\\';
        component = position + 1;
    }
    return swprintf(path, PATH_CAPACITY, L"%ls\\%ls", root, relative) >= 0;
}

static BOOL ensure_directory(const wchar_t *path) {
    return CreateDirectoryW(path, NULL) || (GetLastError() == ERROR_ALREADY_EXISTS && ordinary_directory(path));
}

static BOOL prepare_entry(const wchar_t *root, wchar_t *path, BOOL directory) {
    if (!ordinary_directory(root)) return FALSE;

    for (wchar_t *position = path + wcslen(root) + 1; *position; position++) {
        if (*position != L'\\') continue;
        *position = L'\0';
        BOOL valid = ensure_directory(path);
        *position = L'\\';
        if (!valid) return FALSE;
    }
    return !directory || ensure_directory(path);
}

static size_t write_entry(void *opaque, mz_uint64 offset, const void *buffer, size_t size) {
    (void)offset;
    Output *output = opaque;
    if (!continue_extracting(output->progress) || size > MAXDWORD) return 0;

    DWORD written = 0;
    return WriteFile(output->file, buffer, (DWORD)size, &written, NULL) ? written : 0;
}

static BOOL unpack_archive(mz_zip_archive *zip, const wchar_t *root, Progress *progress) {
    mz_uint count = mz_zip_reader_get_num_files(zip);
    if (!count) return FALSE;

    for (mz_uint index = 0; index < count; index++) {
        if (!continue_extracting(progress)) return FALSE;

        mz_zip_archive_file_stat info;
        char name[PATH_CAPACITY];
        wchar_t path[PATH_CAPACITY];
        mz_uint bytes = mz_zip_reader_get_filename(zip, index, NULL, 0);
        if (!bytes || bytes > sizeof(name) || mz_zip_reader_get_filename(zip, index, name, sizeof(name)) != bytes ||
            strlen(name) + 1 != bytes || !mz_zip_reader_file_stat(zip, index, &info) || !info.m_is_supported) return FALSE;

        unsigned type = info.m_external_attr >> 16 & 0170000;
        if (info.m_external_attr & FILE_ATTRIBUTE_REPARSE_POINT) return FALSE;
        if ((info.m_version_made_by >> 8) == 3 && type && type != (info.m_is_directory ? 0040000 : 0100000)) return FALSE;
        if (!build_output_path(root, name, info.m_is_directory, path) ||
            !prepare_entry(root, path, info.m_is_directory)) return FALSE;
        if (info.m_is_directory) continue;

        HANDLE file = CreateFileW(path, GENERIC_WRITE, 0, NULL, CREATE_NEW,
                                  FILE_ATTRIBUTE_NORMAL | FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_SEQUENTIAL_SCAN, NULL);
        if (file == INVALID_HANDLE_VALUE) return FALSE;
        Output output = {file, progress};
        BOOL extracted = mz_zip_reader_extract_to_callback(zip, index, write_entry, &output, 0) != MZ_FALSE;
        CloseHandle(file);
        if (!extracted) return FALSE;
    }
    return TRUE;
}

static BOOL remove_workspace(const wchar_t *path) {
    DWORD attributes = GetFileAttributesW(path);
    if (attributes == INVALID_FILE_ATTRIBUTES) {
        DWORD error = GetLastError();
        return error == ERROR_FILE_NOT_FOUND || error == ERROR_PATH_NOT_FOUND;
    }
    if (!(attributes & FILE_ATTRIBUTE_REPARSE_POINT)) {
        wchar_t child[PATH_CAPACITY];
        if (swprintf(child, ARRAYSIZE(child), L"%ls\\*", path) < 0) return FALSE;
        WIN32_FIND_DATAW entry;
        HANDLE search = FindFirstFileW(child, &entry);
        if (search != INVALID_HANDLE_VALUE) {
            do {
                if (!wcscmp(entry.cFileName, L".") || !wcscmp(entry.cFileName, L"..")) continue;
                if (swprintf(child, ARRAYSIZE(child), L"%ls\\%ls", path, entry.cFileName) < 0) continue;
                if (entry.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) {
                    remove_workspace(child);
                } else {
                    DeleteFileW(child);
                }
            } while (FindNextFileW(search, &entry));
            FindClose(search);
        }
    }
    return RemoveDirectoryW(path);
}

static BOOL run_editor(const wchar_t *root, DWORD *exit_code) {
    wchar_t directory[PATH_CAPACITY];
    wchar_t executable[PATH_CAPACITY];
    if (swprintf(directory, ARRAYSIZE(directory), L"%ls\\LyricFrame", root) < 0 ||
        swprintf(executable, ARRAYSIZE(executable), L"%ls\\LyricFrame.exe", directory) < 0) return FALSE;

    STARTUPINFOW startup = {0};
    PROCESS_INFORMATION process = {0};
    startup.cb = sizeof(startup);
    if (!CreateProcessW(executable, NULL, NULL, NULL, FALSE, 0, NULL, directory, &startup, &process)) return FALSE;

    CloseHandle(process.hThread);
    BOOL waited = WaitForSingleObject(process.hProcess, INFINITE) == WAIT_OBJECT_0 &&
                  GetExitCodeProcess(process.hProcess, exit_code);
    CloseHandle(process.hProcess);
    return waited;
}

int WINAPI WinMain(HINSTANCE instance, HINSTANCE previous, LPSTR command_line, int show) {
    (void)instance;
    (void)previous;
    (void)command_line;
    (void)show;

    const wchar_t *problem = L"No se pudo leer LyricFrame.exe. Descárgalo de nuevo desde el repositorio oficial.";
    wchar_t executable[PATH_CAPACITY];
    DWORD length = GetModuleFileNameW(NULL, executable, ARRAYSIZE(executable));
    FILE *file = length && length < ARRAYSIZE(executable) ? _wfopen(executable, L"rb") : NULL;
    if (file) {
        mz_zip_archive zip = {0};
        if (locate_zip(file, &zip)) {
            wchar_t root[PATH_CAPACITY];
            BOOL have_workspace = create_workspace(root);
            Progress progress = {GetTickCount64(), NULL, FALSE};
            BOOL extracted = have_workspace && unpack_archive(&zip, root, &progress);
            if (progress.window) DestroyWindow(progress.window);
            mz_zip_reader_end(&zip);
            fclose(file);
            file = NULL;

            DWORD status = 1;
            if (extracted) {
                problem = run_editor(root, &status) ? NULL : L"No se pudo abrir la ventana de LyricFrame.";
            } else {
                problem = progress.cancelled ? NULL : L"No se pudieron preparar los archivos de LyricFrame. Comprueba el espacio libre en el disco y vuelve a intentarlo.";
                if (progress.cancelled) status = 0;
            }
            if (have_workspace) {
                for (unsigned attempt = 0; attempt < 5 && !remove_workspace(root); attempt++) Sleep(250);
            }
            if (!problem) return (int)status;
        }
        if (file) fclose(file);
    }

    MessageBoxW(NULL, problem, L"LyricFrame", MB_OK | MB_ICONERROR | MB_SETFOREGROUND);
    return 1;
}
