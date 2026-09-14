import { changedFileCount, useGitStore } from "../../stores/useGitStore";
import { useUiStore, type SidebarView } from "../../stores/useUiStore";

type IconName = "files" | "search" | "branch" | "extensions";

function Icon({ name }: { name: IconName }) {
  const paths: Record<IconName, React.ReactNode> = {
    files: <><path d="M5 3h9l5 5v13H5z"/><path d="M14 3v5h5M2 7H1v16h14"/></>,
    search: <><circle cx="10.5" cy="10.5" r="6.5"/><path d="m15.5 15.5 5 5"/></>,
    branch: <><circle cx="6" cy="5" r="2"/><circle cx="18" cy="6" r="2"/><circle cx="6" cy="19" r="2"/><path d="M6 7v10M8 7c3 0 3 6 7 6h1M18 8v3"/></>,
    extensions: <><path d="M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM17 13v8M13 17h8"/></>,
  };
  return <svg viewBox="0 0 24 24" aria-hidden="true">{paths[name]}</svg>;
}

const VIEWS: { id: SidebarView; label: string; icon: IconName; hint: string }[] = [
  { id: "explorer", label: "Explorer", icon: "files", hint: "Explorer (Ctrl+Shift+E)" },
  { id: "source-control", label: "Source Control", icon: "branch", hint: "Source Control (Ctrl+Shift+G)" },
];

export function ActivityBar() {
  const sidebarView = useUiStore((state) => state.sidebarView);
  const setSidebarView = useUiStore((state) => state.setSidebarView);
  const status = useGitStore((state) => state.status);
  const changeCount = changedFileCount(status);

  return (
    <nav className="activity-bar" aria-label="Primary">
      {VIEWS.map((view) => (
        <button
          key={view.id}
          className={`activity-button ${sidebarView === view.id ? "active" : ""}`}
          title={view.hint}
          aria-label={view.label}
          aria-pressed={sidebarView === view.id}
          onClick={() => setSidebarView(view.id)}
        >
          <Icon name={view.icon} />
          {view.id === "source-control" && changeCount > 0 && (
            <span className="activity-badge" aria-label={`${changeCount} changed files`}>
              {changeCount}
            </span>
          )}
        </button>
      ))}

      <button className="activity-button" title="Search (coming soon)" aria-label="Search" disabled>
        <Icon name="search" />
      </button>
      <button className="activity-button" title="Extensions (coming soon)" aria-label="Extensions" disabled>
        <Icon name="extensions" />
      </button>
    </nav>
  );
}
