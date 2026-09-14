import { useEffect, useMemo, useState } from "react";
import type { GitHubRepo } from "@forge/shared";
import { useGitHubStore } from "../../stores/useGitHubStore";
import { useUiStore } from "../../stores/useUiStore";

const relativeTime = (iso: string | null): string => {
  if (!iso) return "";
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const days = Math.floor((Date.now() - then) / 86_400_000);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 30) return `${days}d ago`;
  if (days < 365) return `${Math.floor(days / 30)}mo ago`;
  return `${Math.floor(days / 365)}y ago`;
};

/**
 * Sits at the bottom of the Source Control panel: GitHub device-flow sign in,
 * then the user's repositories with a one-click Clone that hands the folder
 * back to `useWorkspaceStore.openFolder`.
 */
export function GitHubConnect() {
  const authStatus = useGitHubStore((state) => state.authStatus);
  const deviceAuth = useGitHubStore((state) => state.deviceAuth);
  const session = useGitHubStore((state) => state.session);
  const repos = useGitHubStore((state) => state.repos);
  const loading = useGitHubStore((state) => state.loading);
  const connecting = useGitHubStore((state) => state.connecting);
  const cloningRepo = useGitHubStore((state) => state.cloningRepo);
  const error = useGitHubStore((state) => state.error);
  const loadStatus = useGitHubStore((state) => state.loadStatus);
  const startAuth = useGitHubStore((state) => state.startAuth);
  const pollAuth = useGitHubStore((state) => state.pollAuth);
  const cancelAuth = useGitHubStore((state) => state.cancelAuth);
  const signOut = useGitHubStore((state) => state.signOut);
  const loadRepos = useGitHubStore((state) => state.loadRepos);
  const clone = useGitHubStore((state) => state.clone);
  const clearError = useGitHubStore((state) => state.clearError);
  const setSidebarView = useUiStore((state) => state.setSidebarView);

  const [expanded, setExpanded] = useState(true);
  const [filter, setFilter] = useState("");
  const [clientId, setClientId] = useState("");
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    void loadStatus();
  }, [loadStatus]);

  // Poll GitHub while the device flow is waiting for the user to approve.
  useEffect(() => {
    if (!connecting || deviceAuth?.status !== "polling") return;
    const intervalMs = ((deviceAuth.interval ?? 5) + 1) * 1000;
    const interval = window.setInterval(() => void pollAuth(), intervalMs);
    return () => window.clearInterval(interval);
  }, [connecting, deviceAuth?.status, deviceAuth?.interval, pollAuth]);

  const connected = authStatus?.connected ?? false;
  const isPolling = connecting && deviceAuth?.status === "polling";

  useEffect(() => {
    if (connected && repos.length === 0 && expanded) void loadRepos();
  }, [connected, repos.length, expanded, loadRepos]);

  const visibleRepos = useMemo(() => {
    const query = filter.trim().toLowerCase();
    if (!query) return repos;
    return repos.filter((repo: GitHubRepo) => repo.fullName.toLowerCase().includes(query));
  }, [repos, filter]);

  const copyCode = async () => {
    if (!deviceAuth?.userCode) return;
    try {
      await navigator.clipboard.writeText(deviceAuth.userCode);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  };

  return (
    <section className="github-panel">
      <header className="github-header">
        <button className="github-header-toggle" onClick={() => setExpanded((value) => !value)} aria-expanded={expanded}>
          <span className={`tree-chevron ${expanded ? "open" : ""}`}>⌄</span>
          <span>GITHUB</span>
        </button>
        {connected && session && (
          <button className="github-signout" onClick={() => void signOut()} title="Sign out of GitHub">
            @{session.login} · Sign out
          </button>
        )}
      </header>

      {expanded && (
        <div className="github-body">
          {!authStatus && loading && <p className="scm-hint">Checking GitHub connection…</p>}

          {/* 1 — signed out */}
          {!connected && !isPolling && authStatus && (
            <>
              {!authStatus.clientIdConfigured && (
                <label className="github-field">
                  <span>OAuth Client ID</span>
                  <input
                    type="text"
                    value={clientId}
                    placeholder="Iv1.0123456789abcdef"
                    onChange={(event) => setClientId(event.target.value)}
                  />
                </label>
              )}
              <button
                className="primary-button"
                disabled={loading || (!authStatus.clientIdConfigured && clientId.trim().length === 0)}
                onClick={() => void startAuth(clientId.trim() || undefined)}
              >
                Connect GitHub
              </button>
              <p className="scm-hint">
                Uses GitHub's device flow — you approve a short code in your browser, no redirect URL needed.
              </p>
            </>
          )}

          {/* 2 — device flow in progress */}
          {isPolling && deviceAuth?.userCode && (
            <div className="github-device">
              <p className="scm-hint">
                Open{" "}
                <button
                  className="github-link"
                  onClick={() => window.open(deviceAuth.verificationUri ?? "https://github.com/login/device", "_blank")}
                >
                  {deviceAuth.verificationUri ?? "https://github.com/login/device"}
                </button>{" "}
                and enter this code:
              </p>
              <button className="github-code" onClick={() => void copyCode()} title="Copy code">
                {deviceAuth.userCode}
              </button>
              <p className="scm-hint">{copied ? "Copied to clipboard" : "Waiting for authorization…"}</p>
              <button className="secondary-button" onClick={cancelAuth}>
                Cancel
              </button>
            </div>
          )}

          {/* 3 — connected: repository list */}
          {connected && (
            <>
              <input
                className="github-filter"
                type="search"
                placeholder="Filter repositories"
                value={filter}
                onChange={(event) => setFilter(event.target.value)}
              />
              <div className="github-repo-list">
                {loading && repos.length === 0 && <p className="scm-hint">Loading repositories…</p>}
                {!loading && visibleRepos.length === 0 && <p className="scm-hint">No repositories found.</p>}
                {visibleRepos.map((repo) => (
                  <div className="github-repo" key={repo.id}>
                    <div className="github-repo-main">
                      <span className="github-repo-name">{repo.fullName}</span>
                      {repo.private && <span className="github-repo-badge">private</span>}
                      <span className="github-repo-meta">
                        {repo.language ? `${repo.language} · ` : ""}
                        {relativeTime(repo.updatedAt)}
                      </span>
                    </div>
                    <button
                      className="secondary-button"
                      disabled={cloningRepo !== null}
                      onClick={() => void clone(repo)}
                      title={`Clone ${repo.cloneUrl}`}
                    >
                      {cloningRepo === repo.fullName ? "Cloning…" : "Clone"}
                    </button>
                  </div>
                ))}
              </div>
              <p className="scm-hint">
                Cloning picks a parent folder, then opens the new repository in the explorer.{" "}
                <button
                  className="github-link"
                  onClick={() => {
                    setSidebarView("explorer");
                    void loadRepos();
                  }}
                >
                  Refresh list
                </button>
              </p>
            </>
          )}

          {error && (
            <p className="scm-message error" role="alert">
              {error}
              <button className="scm-dismiss" aria-label="Dismiss" onClick={clearError}>
                ×
              </button>
            </p>
          )}
        </div>
      )}
    </section>
  );
}
