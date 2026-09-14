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

export function ActivityBar() {
  return (
    <nav className="activity-bar" aria-label="Primary">
      <button className="activity-button active" title="Explorer" aria-label="Explorer"><Icon name="files" /></button>
      <button className="activity-button" title="Search (coming soon)" aria-label="Search"><Icon name="search" /></button>
      <button className="activity-button" title="Source Control (coming soon)" aria-label="Source Control"><Icon name="branch" /></button>
      <button className="activity-button" title="Extensions (coming soon)" aria-label="Extensions"><Icon name="extensions" /></button>
    </nav>
  );
}
