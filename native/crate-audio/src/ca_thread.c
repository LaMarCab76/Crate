#include "ca_thread.h"

#include <stdlib.h>

#if defined(_WIN32)

void ca_mutex_init(ca_mutex *m) { InitializeSRWLock(m); }
void ca_mutex_destroy(ca_mutex *m) { (void)m; }
void ca_mutex_lock(ca_mutex *m) { AcquireSRWLockExclusive(m); }
void ca_mutex_unlock(ca_mutex *m) { ReleaseSRWLockExclusive(m); }
int ca_mutex_trylock(ca_mutex *m) { return TryAcquireSRWLockExclusive(m) ? 1 : 0; }

void ca_cond_init(ca_cond *c) { InitializeConditionVariable(c); }
void ca_cond_destroy(ca_cond *c) { (void)c; }
void ca_cond_wait(ca_cond *c, ca_mutex *m) { SleepConditionVariableSRW(c, m, INFINITE, 0); }
int ca_cond_timedwait(ca_cond *c, ca_mutex *m, uint32_t milliseconds) {
  return SleepConditionVariableSRW(c, m, milliseconds, 0) ? 0 : 1;
}
void ca_cond_signal(ca_cond *c) { WakeConditionVariable(c); }
void ca_cond_broadcast(ca_cond *c) { WakeAllConditionVariable(c); }

typedef struct {
  ca_thread_fn fn;
  void *arg;
} thread_start;

static DWORD WINAPI thread_entry(LPVOID param) {
  thread_start start = *(thread_start *)param;
  free(param);
  start.fn(start.arg);
  return 0;
}

int ca_thread_start(ca_thread *t, ca_thread_fn fn, void *arg) {
  thread_start *start = malloc(sizeof *start);
  if (!start) return -1;
  start->fn = fn;
  start->arg = arg;
  *t = CreateThread(NULL, 0, thread_entry, start, 0, NULL);
  if (!*t) {
    free(start);
    return -1;
  }
  return 0;
}

void ca_thread_join(ca_thread *t) {
  WaitForSingleObject(*t, INFINITE);
  CloseHandle(*t);
}

void ca_sleep_ms(uint32_t milliseconds) { Sleep(milliseconds); }
uint64_t ca_now_ms(void) { return (uint64_t)GetTickCount64(); }

#else

#include <errno.h>
#include <time.h>

void ca_mutex_init(ca_mutex *m) { pthread_mutex_init(m, NULL); }
void ca_mutex_destroy(ca_mutex *m) { pthread_mutex_destroy(m); }
void ca_mutex_lock(ca_mutex *m) { pthread_mutex_lock(m); }
void ca_mutex_unlock(ca_mutex *m) { pthread_mutex_unlock(m); }
int ca_mutex_trylock(ca_mutex *m) { return pthread_mutex_trylock(m) == 0; }

void ca_cond_init(ca_cond *c) { pthread_cond_init(c, NULL); }
void ca_cond_destroy(ca_cond *c) { pthread_cond_destroy(c); }
void ca_cond_wait(ca_cond *c, ca_mutex *m) { pthread_cond_wait(c, m); }

int ca_cond_timedwait(ca_cond *c, ca_mutex *m, uint32_t milliseconds) {
  struct timespec deadline;
  clock_gettime(CLOCK_REALTIME, &deadline);
  deadline.tv_sec += milliseconds / 1000;
  deadline.tv_nsec += (long)(milliseconds % 1000) * 1000000L;
  if (deadline.tv_nsec >= 1000000000L) {
    deadline.tv_sec += 1;
    deadline.tv_nsec -= 1000000000L;
  }
  return pthread_cond_timedwait(c, m, &deadline) == ETIMEDOUT ? 1 : 0;
}

void ca_cond_signal(ca_cond *c) { pthread_cond_signal(c); }
void ca_cond_broadcast(ca_cond *c) { pthread_cond_broadcast(c); }

typedef struct {
  ca_thread_fn fn;
  void *arg;
} thread_start;

static void *thread_entry(void *param) {
  thread_start start = *(thread_start *)param;
  free(param);
  start.fn(start.arg);
  return NULL;
}

int ca_thread_start(ca_thread *t, ca_thread_fn fn, void *arg) {
  thread_start *start = malloc(sizeof *start);
  if (!start) return -1;
  start->fn = fn;
  start->arg = arg;
  if (pthread_create(t, NULL, thread_entry, start) != 0) {
    free(start);
    return -1;
  }
  return 0;
}

void ca_thread_join(ca_thread *t) { pthread_join(*t, NULL); }

void ca_sleep_ms(uint32_t milliseconds) {
  struct timespec duration = {(time_t)(milliseconds / 1000), (long)(milliseconds % 1000) * 1000000L};
  while (nanosleep(&duration, &duration) == -1 && errno == EINTR) {}
}

uint64_t ca_now_ms(void) {
  struct timespec now;
  clock_gettime(CLOCK_MONOTONIC, &now);
  return (uint64_t)now.tv_sec * 1000u + (uint64_t)(now.tv_nsec / 1000000L);
}

#endif
