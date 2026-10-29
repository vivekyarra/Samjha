import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

// Passes the requested path to server layouts so sign-in can return the user to where they were going.
export function proxy(request: NextRequest) {
  const headers = new Headers(request.headers);
  headers.set("x-samjha-path", request.nextUrl.pathname + request.nextUrl.search);
  return NextResponse.next({ request: { headers } });
}

export const config = {
  matcher: ["/((?!api|_next/static|_next/image|favicon.ico).*)"],
};
