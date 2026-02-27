import { WWW_ORIGIN } from "@/lib/wwwOrigin";
import { useState } from "react";

export function LocalSignInForm() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);

    try {
      const res = await fetch(`${WWW_ORIGIN}/api/local-auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });

      if (!res.ok) {
        const body = await res.json().catch(() => null);
        setError(
          (body as { error?: string } | null)?.error ?? "Login failed"
        );
        return;
      }

      const data = (await res.json()) as {
        token: string;
        user: {
          id: string;
          email: string;
          displayName: string;
          teamSlug: string;
          teamId: string;
        };
      };

      localStorage.setItem("cmux-local-jwt", data.token);
      localStorage.setItem("cmux-local-user", JSON.stringify(data.user));

      // Signal page reload so stack.ts picks up the new JWT
      window.location.href = `/${data.user.teamSlug}/dashboard`;
    } catch (err) {
      console.error("Login error:", err);
      setError("Network error — is the server running?");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="absolute inset-0 w-screen h-dvh flex items-center justify-center bg-white dark:bg-black">
      <form
        onSubmit={handleSubmit}
        className="flex flex-col gap-4 w-full max-w-sm p-6 rounded-lg border border-neutral-200 dark:border-neutral-800 bg-neutral-50 dark:bg-neutral-900"
      >
        <div className="text-center mb-2">
          <h1 className="text-lg font-semibold text-neutral-900 dark:text-neutral-100">
            Sign in to cmux
          </h1>
          <p className="text-sm text-neutral-500 dark:text-neutral-400">
            Local development mode
          </p>
        </div>

        {error ? (
          <div className="text-sm text-red-600 dark:text-red-400 text-center">
            {error}
          </div>
        ) : null}

        <label className="flex flex-col gap-1">
          <span className="text-sm font-medium text-neutral-700 dark:text-neutral-300">
            Email
          </span>
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            autoFocus
            className="h-9 px-3 rounded-md border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-neutral-800 text-neutral-900 dark:text-neutral-100 text-sm outline-none focus:ring-2 focus:ring-neutral-400 dark:focus:ring-neutral-600"
            placeholder="user@example.com"
          />
        </label>

        <label className="flex flex-col gap-1">
          <span className="text-sm font-medium text-neutral-700 dark:text-neutral-300">
            Password
          </span>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            className="h-9 px-3 rounded-md border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-neutral-800 text-neutral-900 dark:text-neutral-100 text-sm outline-none focus:ring-2 focus:ring-neutral-400 dark:focus:ring-neutral-600"
            placeholder="password"
          />
        </label>

        <button
          type="submit"
          disabled={loading}
          className="h-9 rounded-md bg-neutral-900 text-white dark:bg-neutral-100 dark:text-neutral-900 text-sm font-medium hover:opacity-90 disabled:opacity-50"
        >
          {loading ? "Signing in..." : "Sign in"}
        </button>
      </form>
    </div>
  );
}
