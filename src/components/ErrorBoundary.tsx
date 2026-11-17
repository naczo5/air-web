import { Component, type ErrorInfo, type ReactNode } from "react";

type Props = { children: ReactNode };
type State = { error?: Error };

/**
 * Catches render-phase errors so a single bad scene, save or panel cannot take
 * the whole player down.
 *
 * Without this, any thrown component error unmounts the entire React tree and
 * the user is left on a blank page with their progress stranded in IndexedDB
 * and no way to reach the menus. The fallback keeps the saved data intact and
 * offers a reload, which is the only safe recovery for an unknown render bug.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = {};

  static getDerivedStateFromError(error: unknown): State {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // Keep the details in the console for a bug report; never render them into
    // the page, because a stack can include scenario text or asset paths.
    console.error("AIR player render error", error, info.componentStack);
  }

  render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <main className="loading-screen">
        <div className="loading-inner" role="alert">
          <span className="loading-mark" aria-hidden="true">AIR</span>
          <p>The player hit an unexpected error. Your saves are stored in this browser and are not affected.</p>
          <div className="error-actions">
            <button className="text-button" onClick={() => this.setState({ error: undefined })}>Try again</button>
            <button className="text-button" onClick={() => window.location.reload()}>Reload</button>
          </div>
        </div>
      </main>
    );
  }
}
