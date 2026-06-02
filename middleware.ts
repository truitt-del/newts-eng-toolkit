import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

export function middleware(request: NextRequest) {
  const authorizationHeader = request.headers.get('authorization');

  if (authorizationHeader) {
    const [type, credentials] = authorizationHeader.split(' ');
    if (type.toLowerCase() === 'basic' && credentials) {
      try {
        const decoded = atob(credentials);
        const [_, password] = decoded.split(':');
        const expectedPassword = process.env.APP_PASSWORD;

        // Allow access if password matches the APP_PASSWORD env variable
        if (expectedPassword && password === expectedPassword) {
          return NextResponse.next();
        }
      } catch (e) {
        // Fall through to 401 on decode failure
      }
    }
  }

  return new NextResponse('Authentication Required', {
    status: 401,
    headers: {
      'WWW-Authenticate': 'Basic realm="CAD-AI Sandbox", charset="UTF-8"',
    },
  });
}

export const config = {
  matcher: [
    /*
     * Match all request paths except for the ones starting with:
     * - _next/static (static files)
     * - _next/image (image optimization files)
     * - favicon.ico (favicon file)
     * - public files ending with common media extensions
     */
    '/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|css|js)$).*)',
  ],
};
