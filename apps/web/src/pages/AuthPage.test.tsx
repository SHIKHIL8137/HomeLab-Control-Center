import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AuthPage } from './AuthPage';

const renderPage = (mode: 'setup' | 'login') =>
  render(
    <QueryClientProvider client={new QueryClient()}>
      <AuthPage mode={mode} />
    </QueryClientProvider>,
  );

afterEach(() => vi.restoreAllMocks());

describe('AuthPage', () => {
  it('requires username and password to sign in', async () => {
    renderPage('login');
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByText('Username is required')).toBeInTheDocument();
    expect(screen.getByText('Password is required')).toBeInTheDocument();
  });

  it('enforces the 12-character minimum during setup and asks for the token', async () => {
    renderPage('setup');
    await userEvent.type(screen.getByLabelText('Username'), 'admin');
    await userEvent.type(screen.getByLabelText('Password'), 'short');
    await userEvent.click(screen.getByRole('button', { name: 'Create administrator' }));
    expect(await screen.findByText('At least 12 characters')).toBeInTheDocument();
    expect(screen.getByText('Enter the one-time setup token')).toBeInTheDocument();
    // The help text must not suggest the token appears in logs, and must not name server variables.
    expect(screen.getByText(/never shown in logs/)).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/HLCC_|PROXY_TOKEN/);
  });

  it('shows the server error without echoing the password', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          error: { code: 'invalid_credentials', message: 'Invalid username or password' },
        }),
        { status: 401 },
      ),
    );
    renderPage('login');
    await userEvent.type(screen.getByLabelText('Username'), 'admin');
    await userEvent.type(screen.getByLabelText('Password'), 'hunter2-hunter2');
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent('Invalid username or password'),
    );
    expect(document.body.textContent).not.toContain('hunter2-hunter2');
  });
});
