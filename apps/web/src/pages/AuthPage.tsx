import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { useQueryClient } from '@tanstack/react-query';
import { api, ApiRequestError } from '../lib/api';

interface Values {
  username: string;
  password: string;
  setupToken: string;
}

export function AuthPage({ mode }: { mode: 'setup' | 'login' }) {
  const qc = useQueryClient();
  const [serverError, setServerError] = useState<string | null>(null);
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<Values>();
  const setup = mode === 'setup';

  const onSubmit = handleSubmit(async (v) => {
    setServerError(null);
    try {
      await api(setup ? '/auth/setup' : '/auth/login', {
        method: 'POST',
        body: setup ? v : { username: v.username, password: v.password },
      });
      await qc.invalidateQueries({ queryKey: ['auth'] });
    } catch (e) {
      setServerError(e instanceof ApiRequestError ? e.message : 'Something went wrong');
    }
  });

  const input = 'w-full rounded-lg border border-line bg-bg px-3 py-2 text-sm';
  return (
    <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center px-4">
      <h1 className="text-xl font-semibold">HomeLab Control Center</h1>
      <p className="mb-6 mt-1 text-sm text-muted">
        {setup ? 'First-run setup: create the administrator account.' : 'Sign in to continue.'}
      </p>
      <form
        onSubmit={onSubmit}
        noValidate
        className="space-y-4"
        aria-label={setup ? 'Setup' : 'Sign in'}
      >
        {setup && (
          <div>
            <label htmlFor="setupToken" className="mb-1 block text-sm font-medium">
              Setup token
            </label>
            <input
              id="setupToken"
              className={input}
              autoComplete="off"
              aria-invalid={Boolean(errors.setupToken)}
              {...register('setupToken', { required: 'Enter the token from the server log' })}
            />
            <p className="mt-1 text-xs text-muted">
              Printed once in the API log, or the HLCC_SETUP_TOKEN value.
            </p>
            {errors.setupToken && (
              <p role="alert" className="mt-1 text-xs text-bad">
                {errors.setupToken.message}
              </p>
            )}
          </div>
        )}
        <div>
          <label htmlFor="username" className="mb-1 block text-sm font-medium">
            Username
          </label>
          <input
            id="username"
            className={input}
            autoComplete="username"
            aria-invalid={Boolean(errors.username)}
            {...register('username', {
              required: 'Username is required',
              minLength: setup ? { value: 3, message: 'At least 3 characters' } : undefined,
            })}
          />
          {errors.username && (
            <p role="alert" className="mt-1 text-xs text-bad">
              {errors.username.message}
            </p>
          )}
        </div>
        <div>
          <label htmlFor="password" className="mb-1 block text-sm font-medium">
            Password
          </label>
          <input
            id="password"
            type="password"
            className={input}
            autoComplete={setup ? 'new-password' : 'current-password'}
            aria-invalid={Boolean(errors.password)}
            {...register('password', {
              required: 'Password is required',
              minLength: setup ? { value: 12, message: 'At least 12 characters' } : undefined,
            })}
          />
          {errors.password && (
            <p role="alert" className="mt-1 text-xs text-bad">
              {errors.password.message}
            </p>
          )}
        </div>
        {serverError && (
          <p
            role="alert"
            className="rounded-lg border border-bad/40 bg-bad/10 px-3 py-2 text-sm text-bad"
          >
            {serverError}
          </p>
        )}
        <button
          type="submit"
          disabled={isSubmitting}
          className="w-full rounded-lg bg-accent px-3 py-2 text-sm font-semibold text-on-accent disabled:opacity-60"
        >
          {isSubmitting ? 'Please wait…' : setup ? 'Create administrator' : 'Sign in'}
        </button>
      </form>
    </main>
  );
}
