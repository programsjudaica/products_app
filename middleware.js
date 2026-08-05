// Vercel Edge Middleware: protects the entire site (both app versions and all /api/*
// endpoints) behind a single shared password using standard HTTP Basic Auth - the browser
// shows its own native login prompt, no custom login page needed.
//
// Requires an APP_PASSWORD environment variable in Vercel. If it's not set, this middleware
// fails OPEN (does not block anything) rather than accidentally locking everyone out.

export const config = {
  matcher: '/:path*',
};

export default function middleware(request) {
  const expectedPass = process.env.APP_PASSWORD;
  if (!expectedPass) return;

  const authHeader = request.headers.get('authorization');
  if (authHeader) {
    const [scheme, encoded] = authHeader.split(' ');
    if (scheme === 'Basic' && encoded) {
      let decoded = '';
      try { decoded = atob(encoded); } catch (e) {}
      const sepIndex = decoded.indexOf(':');
      const pass = sepIndex >= 0 ? decoded.slice(sepIndex + 1) : '';
      if (pass === expectedPass) {
        return;
      }
    }
  }

  return new Response('Authentication required', {
    status: 401,
    headers: { 'WWW-Authenticate': 'Basic realm="Judaica Spec App"' },
  });
}
