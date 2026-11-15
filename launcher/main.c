#define WIN32_LEAN_AND_MEAN

#include <windows.h>
#include <stdio.h>
#include <string.h>
#include <wchar.h>

enum { PATH_CAPACITY = 4096, LOG_CAPACITY = 4096 };

typedef struct {
    HANDLE process;
    HANDLE job;
    HANDLE input;
    HANDLE output;
    char log[LOG_CAPACITY];
    size_t log_length;
} Server;

typedef enum { BROWSER_FAILED, APP_CLOSED, SERVER_STOPPED } BrowserResult;

static void show_error(const wchar_t *message, const Server *server) {
    wchar_t details[LOG_CAPACITY * 2];
    if (server && server->log_length) {
        wchar_t log[LOG_CAPACITY];
        if (MultiByteToWideChar(CP_UTF8, 0, server->log, -1, log, LOG_CAPACITY)) {
            swprintf(details, ARRAYSIZE(details), L"%ls\n\n%ls", message, log);
            message = details;
        }
    }
    MessageBoxW(NULL, message, L"LyricFrame", MB_OK | MB_ICONERROR | MB_SETFOREGROUND);
}

static BOOL is_file(const wchar_t *path) {
    DWORD attributes = GetFileAttributesW(path);
    return attributes != INVALID_FILE_ATTRIBUTES && !(attributes & FILE_ATTRIBUTE_DIRECTORY);
}

static HANDLE create_server_job(HANDLE process) {
    HANDLE job = CreateJobObjectW(NULL, NULL);
    if (!job) return NULL;

    JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits = {0};
    limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    if (!SetInformationJobObject(job, JobObjectExtendedLimitInformation, &limits, sizeof(limits)) ||
        !AssignProcessToJobObject(job, process)) {
        CloseHandle(job);
        return NULL;
    }
    return job;
}

static BOOL start_server(Server *server, const wchar_t *root, const wchar_t *node) {
    SECURITY_ATTRIBUTES inheritable = {sizeof(inheritable), NULL, TRUE};
    HANDLE input_read = NULL;
    HANDLE output_write = NULL;
    PROCESS_INFORMATION process = {0};
    STARTUPINFOW startup = {0};
    wchar_t command[] = L"node.exe server.mjs --desktop";

    if (!CreatePipe(&input_read, &server->input, &inheritable, 0)) goto cleanup;
    if (!CreatePipe(&server->output, &output_write, &inheritable, 0)) goto cleanup;
    if (!SetHandleInformation(server->input, HANDLE_FLAG_INHERIT, 0) ||
        !SetHandleInformation(server->output, HANDLE_FLAG_INHERIT, 0)) goto cleanup;

    startup.cb = sizeof(startup);
    startup.dwFlags = STARTF_USESTDHANDLES;
    startup.hStdInput = input_read;
    startup.hStdOutput = output_write;
    startup.hStdError = output_write;
    if (CreateProcessW(node, command, NULL, NULL, TRUE, CREATE_NO_WINDOW | CREATE_SUSPENDED,
                       NULL, root, &startup, &process)) {
        server->process = process.hProcess;
        server->job = create_server_job(process.hProcess);
        if (ResumeThread(process.hThread) == (DWORD)-1) {
            TerminateProcess(process.hProcess, 1);
            CloseHandle(process.hProcess);
            server->process = NULL;
        }
        CloseHandle(process.hThread);
    }

cleanup:
    if (input_read) CloseHandle(input_read);
    if (output_write) CloseHandle(output_write);
    return server->process != NULL;
}

static void read_server_log(Server *server) {
    char chunk[2048];
    for (unsigned reads = 0; reads < 32; reads++) {
        DWORD available;
        DWORD length;
        if (!PeekNamedPipe(server->output, NULL, 0, NULL, &available, NULL) || !available) return;
        if (available > sizeof(chunk)) available = sizeof(chunk);
        if (!ReadFile(server->output, chunk, available, &length, NULL) || !length) return;

        if (server->log_length + length >= sizeof(server->log)) {
            size_t discard = server->log_length + length - sizeof(server->log) + 1;
            server->log_length -= discard;
            memmove(server->log, server->log + discard, server->log_length);
        }
        memcpy(server->log + server->log_length, chunk, length);
        server->log_length += length;
        server->log[server->log_length] = '\0';
    }
}

static unsigned server_port(const char *log) {
    static const char ready[] = "LyricFrame listo. Abre http://127.0.0.1:";
    const char *line = log;
    while (line) {
        if (!strncmp(line, ready, sizeof(ready) - 1)) {
            const char *digit = line + sizeof(ready) - 1;
            unsigned port = 0;
            while (*digit >= '0' && *digit <= '9' && port <= 65535) {
                port = port * 10 + (unsigned)(*digit++ - '0');
            }
            if (port > 0 && port <= 65535 && (*digit == '\n' || (*digit == '\r' && digit[1] == '\n'))) {
                return port;
            }
        }
        const char *newline = strchr(line, '\n');
        line = newline ? newline + 1 : NULL;
    }
    return 0;
}

static unsigned wait_for_server(Server *server) {
    ULONGLONG start = GetTickCount64();
    do {
        read_server_log(server);
        unsigned port = server_port(server->log);
        if (port) return port;
    } while (WaitForSingleObject(server->process, 50) == WAIT_TIMEOUT && GetTickCount64() - start < 20000);
    read_server_log(server);
    return 0;
}

static void stop_server(Server *server) {
    if (server->input) CloseHandle(server->input);
    if (server->process) {
        ULONGLONG start = GetTickCount64();
        while (WaitForSingleObject(server->process, 50) == WAIT_TIMEOUT) {
            read_server_log(server);
            if (GetTickCount64() - start >= 8000) {
                TerminateProcess(server->process, 1);
                break;
            }
        }
        CloseHandle(server->process);
    }
    if (server->job) CloseHandle(server->job);
    if (server->output) CloseHandle(server->output);
}

static BOOL find_browser(BOOL edge, wchar_t *path) {
    const wchar_t *exe = edge ? L"msedge.exe" : L"chrome.exe";
    const wchar_t *directory = edge ? L"Microsoft\\Edge\\Application" : L"Google\\Chrome\\Application";
    const wchar_t *variables[] = {L"ProgramFiles(x86)", L"ProgramFiles", L"LOCALAPPDATA"};
    for (unsigned i = 0; i < ARRAYSIZE(variables); i++) {
        wchar_t base[PATH_CAPACITY];
        DWORD size = GetEnvironmentVariableW(variables[i], base, ARRAYSIZE(base));
        if (size && size < ARRAYSIZE(base) &&
            swprintf(path, PATH_CAPACITY, L"%ls\\%ls\\%ls", base, directory, exe) > 0 && is_file(path)) return TRUE;
    }

    wchar_t key[128];
    swprintf(key, ARRAYSIZE(key), L"SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\%ls", exe);
    HKEY hives[] = {HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE};
    for (unsigned i = 0; i < ARRAYSIZE(hives); i++) {
        DWORD size = PATH_CAPACITY * sizeof(wchar_t);
        if (RegGetValueW(hives[i], key, NULL, RRF_RT_REG_SZ | RRF_RT_REG_EXPAND_SZ,
                         NULL, path, &size) == ERROR_SUCCESS && is_file(path)) return TRUE;
    }
    return FALSE;
}

static BOOL create_profile(wchar_t *profile) {
    wchar_t temp[PATH_CAPACITY];
    DWORD size = GetTempPathW(ARRAYSIZE(temp), temp);
    if (!size || size >= ARRAYSIZE(temp)) return FALSE;

    for (unsigned i = 0; i < 8; i++) {
        if (swprintf(profile, PATH_CAPACITY, L"%lsLyricFrame-browser-%lu-%llu-%u", temp,
                     GetCurrentProcessId(), GetTickCount64(), i) < 0) return FALSE;
        if (CreateDirectoryW(profile, NULL)) return TRUE;
        if (GetLastError() != ERROR_ALREADY_EXISTS) return FALSE;
    }
    return FALSE;
}

static BOOL remove_directory(const wchar_t *path) {
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
                    remove_directory(child);
                } else {
                    if (entry.dwFileAttributes & FILE_ATTRIBUTE_READONLY) {
                        SetFileAttributesW(child, entry.dwFileAttributes & ~FILE_ATTRIBUTE_READONLY);
                    }
                    DeleteFileW(child);
                }
            } while (FindNextFileW(search, &entry));
            FindClose(search);
        }
    }
    return RemoveDirectoryW(path);
}

typedef struct {
    DWORD pid;
    HWND app_window;
} BrowserWindow;

static BOOL CALLBACK find_app_window(HWND window, LPARAM data) {
    BrowserWindow *browser = (BrowserWindow *)data;
    DWORD pid = 0;
    GetWindowThreadProcessId(window, &pid);
    if (pid != browser->pid || !IsWindowVisible(window) || GetWindow(window, GW_OWNER)) return TRUE;

    wchar_t class_name[64];
    if (GetClassNameW(window, class_name, ARRAYSIZE(class_name)) && !wcscmp(class_name, L"Chrome_WidgetWin_1")) {
        browser->app_window = window;
        return FALSE;
    }
    return TRUE;
}

static BrowserResult monitor_browser(Server *server, const PROCESS_INFORMATION *process) {
    ULONGLONG start = GetTickCount64();
    ULONGLONG last_visible = 0;
    BrowserWindow browser = {process->dwProcessId, NULL};
    HANDLE processes[] = {server->process, process->hProcess};
    for (;;) {
        browser.app_window = NULL;
        EnumWindows(find_app_window, (LPARAM)&browser);
        ULONGLONG now = GetTickCount64();
        if (browser.app_window) last_visible = now;

        read_server_log(server);
        DWORD completed = WaitForMultipleObjects(ARRAYSIZE(processes), processes, FALSE, 200);
        if (completed == WAIT_OBJECT_0) {
            if (browser.app_window) PostMessageW(browser.app_window, WM_CLOSE, 0, 0);
            return SERVER_STOPPED;
        }
        if (completed == WAIT_OBJECT_0 + 1) return last_visible ? APP_CLOSED : BROWSER_FAILED;
        if (completed == WAIT_FAILED) return BROWSER_FAILED;
        if (last_visible && now - last_visible > 1500) return APP_CLOSED;
        if (!last_visible && now - start > 25000) return BROWSER_FAILED;
    }
}

static BrowserResult open_browser(Server *server, const wchar_t *path, const wchar_t *profile, unsigned port) {
    wchar_t command[PATH_CAPACITY * 2 + 256];
    if (swprintf(command, ARRAYSIZE(command),
                 L"\"%ls\" --app=http://127.0.0.1:%u --user-data-dir=\"%ls\" --no-first-run "
                 L"--disable-background-mode --disable-features=msEdgeFirstRunExperience", path, port, profile) < 0) {
        return BROWSER_FAILED;
    }

    STARTUPINFOW startup = {0};
    startup.cb = sizeof(startup);
    PROCESS_INFORMATION process = {0};
    if (!CreateProcessW(path, command, NULL, NULL, FALSE, 0, NULL, NULL, &startup, &process)) return BROWSER_FAILED;
    CloseHandle(process.hThread);
    BrowserResult result = monitor_browser(server, &process);
    if (WaitForSingleObject(process.hProcess, 2000) == WAIT_TIMEOUT) {
        TerminateProcess(process.hProcess, 1);
        WaitForSingleObject(process.hProcess, 1000);
    }
    CloseHandle(process.hProcess);
    return result;
}

int WINAPI WinMain(HINSTANCE instance, HINSTANCE previous, LPSTR command_line, int show) {
    (void)instance;
    (void)previous;
    (void)command_line;
    (void)show;

    wchar_t root[PATH_CAPACITY];
    wchar_t node[PATH_CAPACITY];
    wchar_t script[PATH_CAPACITY];
    DWORD length = GetModuleFileNameW(NULL, root, ARRAYSIZE(root));
    wchar_t *filename = length && length < ARRAYSIZE(root) ? wcsrchr(root, L'\\') : NULL;
    if (filename) filename[1] = L'\0';
    if (!filename || swprintf(node, ARRAYSIZE(node), L"%lsruntime\\node.exe", root) < 0 || !is_file(node) ||
        swprintf(script, ARRAYSIZE(script), L"%lsserver.mjs", root) < 0 || !is_file(script)) {
        show_error(L"Faltan archivos de LyricFrame. Extrae el ZIP completo y abre LyricFrame.exe desde esa carpeta.", NULL);
        return 1;
    }

    wchar_t edge[PATH_CAPACITY];
    wchar_t chrome[PATH_CAPACITY];
    BOOL have_edge = find_browser(TRUE, edge);
    BOOL have_chrome = find_browser(FALSE, chrome);
    if (!have_edge && !have_chrome) {
        show_error(L"Instala Microsoft Edge o Google Chrome para abrir la ventana de LyricFrame.", NULL);
        return 1;
    }

    Server server = {0};
    const wchar_t *problem = NULL;
    if (start_server(&server, root, node)) {
        unsigned port = wait_for_server(&server);
        if (port) {
            BrowserResult result = BROWSER_FAILED;
            const wchar_t *browsers[] = {have_edge ? edge : NULL, have_chrome ? chrome : NULL};
            for (unsigned i = 0; i < ARRAYSIZE(browsers) && result == BROWSER_FAILED; i++) {
                if (!browsers[i]) continue;
                wchar_t profile[PATH_CAPACITY];
                if (!create_profile(profile)) {
                    problem = L"No se pudo crear el perfil temporal para abrir la ventana de LyricFrame.";
                    break;
                }
                result = open_browser(&server, browsers[i], profile, port);
                for (unsigned attempt = 0; attempt < 5 && !remove_directory(profile); attempt++) Sleep(150);
            }
            if (result == SERVER_STOPPED) problem = L"El proceso local de LyricFrame se cerró de forma inesperada.";
            if (result == BROWSER_FAILED && !problem) problem = L"No se pudo abrir LyricFrame en Edge o Chrome.";
        } else {
            problem = L"El proceso local de LyricFrame no inició. Extrae el ZIP completo y vuelve a abrir LyricFrame.exe.";
        }
    } else {
        problem = L"No se pudo iniciar el entorno local de LyricFrame.";
    }
    stop_server(&server);
    if (problem) show_error(problem, &server);
    return problem != NULL;
}
