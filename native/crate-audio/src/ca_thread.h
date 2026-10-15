/* Minimal portable threading: mutex, condition variable, thread, sleep. */
#ifndef CA_THREAD_H
#define CA_THREAD_H

#include <stdint.h>

#if defined(_WIN32)
#  ifndef WIN32_LEAN_AND_MEAN
#    define WIN32_LEAN_AND_MEAN
#  endif
#  include <windows.h>
typedef SRWLOCK ca_mutex;
typedef CONDITION_VARIABLE ca_cond;
typedef HANDLE ca_thread;
#else
#  include <pthread.h>
typedef pthread_mutex_t ca_mutex;
typedef pthread_cond_t ca_cond;
typedef pthread_t ca_thread;
#endif

typedef void (*ca_thread_fn)(void *arg);

void ca_mutex_init(ca_mutex *m);
void ca_mutex_destroy(ca_mutex *m);
void ca_mutex_lock(ca_mutex *m);
void ca_mutex_unlock(ca_mutex *m);
/* Never blocks; returns 1 when the lock was taken. Safe in the audio callback. */
int ca_mutex_trylock(ca_mutex *m);

void ca_cond_init(ca_cond *c);
void ca_cond_destroy(ca_cond *c);
void ca_cond_wait(ca_cond *c, ca_mutex *m);
/* Returns 0 when signalled, 1 on timeout. */
int ca_cond_timedwait(ca_cond *c, ca_mutex *m, uint32_t milliseconds);
void ca_cond_signal(ca_cond *c);
void ca_cond_broadcast(ca_cond *c);

int ca_thread_start(ca_thread *t, ca_thread_fn fn, void *arg);
void ca_thread_join(ca_thread *t);

void ca_sleep_ms(uint32_t milliseconds);
uint64_t ca_now_ms(void);

#endif /* CA_THREAD_H */
