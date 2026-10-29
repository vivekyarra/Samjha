"use client";
import type { ReactNode } from "react";

export function ErrorState({
  title = "Something went wrong",
  body = "That didn't load. Your progress is safe, try again in a moment.",
  retry,
  action,
}: {
  title?: string;
  body?: ReactNode;
  retry?: () => void;
  action?: ReactNode;
}) {
  return (
    <div role="alert" className="card flex flex-col items-center gap-3 px-6 py-10 text-center">
      <svg width="36" height="36" viewBox="0 0 24 24" aria-hidden className="text-red">
        <path d="M12 3l9.5 17h-19z" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
        <path d="M12 10v4.5M12 17.2v.3" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      </svg>
      <h2 className="h2">{title}</h2>
      {body && <div className="muted max-w-sm">{body}</div>}
      {(retry || action) && (
        <div className="flex flex-wrap justify-center gap-2">
          {retry && (
            <button type="button" className="btn-primary" onClick={() => retry()}>
              Try again
            </button>
          )}
          {action}
        </div>
      )}
    </div>
  );
}

export default ErrorState;
