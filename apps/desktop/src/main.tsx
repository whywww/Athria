import React from "react";
import ReactDOM from "react-dom/client";
import { QueryClient } from "@tanstack/query-core";
import { QueryClientProvider } from "@tanstack/react-query";
import { App } from "./App";
import "./styles.css";

const queryClient = new QueryClient({ defaultOptions: { queries: { retry: 1, staleTime: 10_000 } } });

/** Surfaces a render failure instead of leaving an empty window. */
class AppErrorBoundary extends React.Component<{ children: React.ReactNode }, { error: Error | null }> {
  state: { error: Error | null } = { error: null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return <div className="shell"><main className="primary-main"><div className="error" role="alert"><strong>Athria could not display this screen.</strong><p>{error.message}</p><button type="button" onClick={() => this.setState({ error: null })}>Try again</button></div></main></div>;
  }
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <AppErrorBoundary>
      <QueryClientProvider client={queryClient}><App /></QueryClientProvider>
    </AppErrorBoundary>
  </React.StrictMode>,
);
