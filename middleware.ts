import { createServerClient, type CookieOptions } from '@supabase/ssr';
import { NextRequest, NextResponse } from 'next/server';

export async function middleware(request: NextRequest) {
  // eBay's servers call these directly (challenge handshake + notification
  // delivery) with no way to hold a logged-in session, so they must bypass
  // the auth check entirely — otherwise every call gets redirected to
  // /login and the webhook never fires.
  if (request.nextUrl.pathname.startsWith('/api/ebay/webhooks/')) {
    return NextResponse.next();
  }

  // The cron-triggered search scan (api/index.py) is called by cron-job.org
  // with no browser session — it authenticates itself via the CRON_SECRET
  // bearer header instead, so it must bypass the session check too.
  if (request.nextUrl.pathname === '/api/index') {
    return NextResponse.next();
  }

  let response = NextResponse.next({ request });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet: { name: string; value: string; options: CookieOptions }[]) {
          cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
          response = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) =>
            response.cookies.set(name, value, options)
          );
        },
      },
    }
  );

  const { data: { session } } = await supabase.auth.getSession();
  const { pathname } = request.nextUrl;

  const isAuthRoute = pathname.startsWith('/login') || pathname.startsWith('/auth/callback');

  if (isAuthRoute) {
    if (session && pathname.startsWith('/login')) {
      return NextResponse.redirect(new URL('/', request.url));
    }
    return response;
  }

  if (!session) {
    return NextResponse.redirect(new URL('/login', request.url));
  }

  if (session.user.email !== 'dmod85@gmail.com') {
    await supabase.auth.signOut();
    return NextResponse.redirect(new URL('/login?error=unauthorized', request.url));
  }

  return response;
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon\\.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)'],
};
