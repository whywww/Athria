import { T } from "./i18n";
import React from "react";
import ReactDOM from "react-dom/client";
import { QueryClient } from "@tanstack/query-core";
import { QueryClientProvider } from "@tanstack/react-query";
import { App } from "./App";
import { LanguageProvider, readLanguage } from "./i18n";
import "./styles.css";

const queryClient = new QueryClient({ defaultOptions: { queries: { retry: 1, staleTime: 10_000 } } });
document.documentElement.lang = readLanguage();

/** Surfaces a render failure instead of leaving an empty window. */
class AppErrorBoundary extends React.Component<{ children: React.ReactNode }, { error: Error | null }> {
  state: { error: Error | null } = { error: null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return <div className="shell"><main className="primary-main"><div className="error" role="alert"><strong><T>{"Athria could not display this screen."}</T></strong><p>{error.message}</p><button type="button" onClick={() => this.setState({ error: null })}><T>{"Try again"}</T></button></div></main></div>;
  }
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <AppErrorBoundary>
      <LanguageProvider><QueryClientProvider client={queryClient}><App /></QueryClientProvider></LanguageProvider>
    </AppErrorBoundary>
  </React.StrictMode>,
);
