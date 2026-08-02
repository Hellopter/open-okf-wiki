import { CircleAlert } from "lucide-react";
import { Component, type ErrorInfo, type ReactNode } from "react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";

type Props = {
  children: ReactNode;
};

type State = {
  error: Error | null;
};

/**
 * Class boundary required by React's error-boundary API.
 * Prefer the function export `AppErrorBoundary` at the app root so static
 * composition graphs can resolve the shell entry.
 */
class ErrorBoundaryInner extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("App error boundary caught:", error, info.componentStack);
  }

  private handleReload = () => {
    window.location.assign("/");
  };

  private handleRetry = () => {
    this.setState({ error: null });
  };

  render() {
    const { error } = this.state;
    if (!error) {
      return this.props.children;
    }

    return (
      <div
        className="flex min-h-svh flex-col items-center justify-center gap-4 bg-background p-6 text-foreground"
        data-testid="app-error-boundary"
      >
        <Alert variant="destructive" className="max-w-md">
          <CircleAlert />
          <AlertTitle>Something went wrong</AlertTitle>
          <AlertDescription>
            The operator UI hit an unexpected error. You can retry rendering or return to the home
            page.
          </AlertDescription>
          <pre className="col-start-2 mt-2 max-h-40 overflow-auto rounded-md border bg-muted/40 p-3 text-left font-mono text-xs text-destructive">
            {error.message}
          </pre>
        </Alert>
        <div className="flex flex-wrap items-center justify-center gap-2">
          <Button type="button" variant="outline" onClick={this.handleRetry}>
            Try again
          </Button>
          <Button type="button" onClick={this.handleReload}>
            Go home
          </Button>
        </div>
      </div>
    );
  }
}

/** App-shell error boundary (function export for composition scanners). */
export function AppErrorBoundary({ children }: Props) {
  return <ErrorBoundaryInner>{children}</ErrorBoundaryInner>;
}
