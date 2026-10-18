/* Mushi's narrow exec-path compatibility bridge, not a filesystem emulator.
 * Prebuilt git and Node contain a compiled-in /data/data/com.termux/.../sh.
 * Redirect libc exec calls for that prefix to Mushi; all other paths and
 * filesystem operations retain ordinary Android semantics. */
#define _GNU_SOURCE
#include <dlfcn.h>
#include <errno.h>
#include <limits.h>
#include <string.h>
#include <unistd.h>

#ifndef MUSHI_PREFIX
#define MUSHI_PREFIX "/data/data/io.carmo.mushi/files/usr"
#endif
static const char old_prefix[] = "/data/data/com.termux/files/usr";
static const char new_prefix[] = MUSHI_PREFIX;

static const char *relocate(const char *path, char buffer[PATH_MAX]) {
    if (!path || strncmp(path, old_prefix, sizeof(old_prefix) - 1) != 0)
        return path;
    const char *suffix = path + sizeof(old_prefix) - 1;
    if (*suffix != '/' && *suffix != '\0') return path;
    size_t length = sizeof(new_prefix) - 1 + strlen(suffix);
    if (length >= PATH_MAX) { errno = ENAMETOOLONG; return NULL; }
    memcpy(buffer, new_prefix, sizeof(new_prefix) - 1);
    strcpy(buffer + sizeof(new_prefix) - 1, suffix);
    return buffer;
}

#define EXEC_WRAPPER(name, parameters, arguments) \
    int name parameters { \
        char translated[PATH_MAX]; \
        const char *destination = relocate(path, translated); \
        if (!destination) return -1; \
        int (*original) parameters = dlsym(RTLD_NEXT, #name); \
        if (!original) { errno = ENOSYS; return -1; } \
        return original arguments; \
    }

EXEC_WRAPPER(execve, (const char *path, char *const argv[], char *const envp[]), (destination, argv, envp))
EXEC_WRAPPER(execv, (const char *path, char *const argv[]), (destination, argv))
EXEC_WRAPPER(execvp, (const char *path, char *const argv[]), (destination, argv))
EXEC_WRAPPER(execvpe, (const char *path, char *const argv[], char *const envp[]), (destination, argv, envp))
