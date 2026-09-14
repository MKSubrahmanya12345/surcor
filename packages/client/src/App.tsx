import { Layout } from "./components/Layout/Layout";
import { useWorkspaceStore } from "./stores/useWorkspaceStore";

export default function App() {
  const error = useWorkspaceStore((state) => state.error);
  const clearError = useWorkspaceStore((state) => state.clearError);

  return (
    <>
      <Layout />
      {error && (
        <div className="error-toast" role="alert">
          <span>{error}</span>
          <button onClick={clearError} aria-label="Dismiss error">×</button>
        </div>
      )}
    </>
  );
}
