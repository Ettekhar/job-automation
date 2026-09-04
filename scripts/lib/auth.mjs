/**
 * auth.mjs -- JWT session auth for the dashboard.
 *
 * Uses the `jose` library (pure ESM, no native deps) for HMAC-SHA256 JWTs.
 * Tokens are stored in an HttpOnly, SameSite=Lax cookie named `__session`.
 *
 * Environment variables used:
 *   AUTH_SECRET         -- >= 32-char random string (required)
 *   ALLOWED_EMAILS      -- comma-separated list of allowed Google account emails
 *   GOOGLE_CLIENT_ID    -- from Google Cloud Console OAuth 2.0 app
 *   GOOGLE_CLIENT_SECRET-- from Google Cloud Console OAuth 2.0 app
 *   GOOGLE_CALLBACK_URL -- full URL to /api/auth/google/callback
 */

import { SignJWT, jwtVerify } from "jose";
import { createHash } from "node:crypto";

const COOKIE_NAME = "__session";
const TOKEN_EXPIRY = "24h";

function getSecret() {
  const s = process.env.AUTH_SECRET;
  if (!s || s.length < 16) {
    // Auto-generate a warning secret if missing (dev only)
    console.warn("[Auth] WARNING: AUTH_SECRET is not set. Using insecure fallback. Set AUTH_SECRET in .env!");
    return new TextEncoder().encode("dev-insecure-fallback-secret-32x");
  }
  return new TextEncoder().encode(s);
}

export async function generateToken(user) {
  const secret = getSecret();
  return await new SignJWT({ ...user })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(TOKEN_EXPIRY)
    .sign(secret);
}

export async function verifyToken(token) {
  try {
    const secret = getSecret();
    const { payload } = await jwtVerify(token, secret);
    return payload;
  } catch {
    return null;
  }
}

export function setSessionCookie(res, token) {
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: 24 * 60 * 60 * 1000,
    path: "/",
  });
}

export function clearSessionCookie(res) {
  res.clearCookie(COOKIE_NAME, { path: "/" });
}

export function authMiddleware(req, res, next) {
  const token = req.cookies?.[COOKIE_NAME];
  if (token) {
    return verifyToken(token).then((payload) => {
      if (payload) {
        req.user = payload;
        return next();
      }
      clearSessionCookie(res);
      return handleLocalOrUnauthorized(req, res, next);
    }).catch(() => handleLocalOrUnauthorized(req, res, next));
  }

  return handleLocalOrUnauthorized(req, res, next);
}

function handleLocalOrUnauthorized(req, res, next) {
  const host = req.hostname || "";
  const ip = req.ip || "";
  const isLocal = host === "localhost" || host === "127.0.0.1" || ip === "127.0.0.1" || ip === "::1" || ip.endsWith("127.0.0.1");

  // If accessing from local machine, automatically permit as Admin
  if (isLocal) {
    req.user = {
      email: (process.env.ALLOWED_EMAILS || "taion16240@gmail.com").split(",")[0].trim(),
      name: "Taion (Admin)",
    };
    return next();
  }

  return _unauthorized(req, res);
}

function _unauthorized(req, res) {
  const acceptsHtml = req.headers.accept?.includes("text/html");
  if (acceptsHtml && !req.path.startsWith("/api/")) {
    return res.redirect("/login");
  }
  return res.status(401).json({ success: false, error: "Unauthorized. Please log in." });
}

export function isEmailAllowed(email) {
  const allowed = process.env.ALLOWED_EMAILS;
  if (!allowed || !allowed.trim()) return true;
  return allowed.split(",").map((e) => e.trim().toLowerCase()).includes(email.toLowerCase());
}

const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_USERINFO_URL = "https://www.googleapis.com/oauth2/v3/userinfo";

export function getGoogleAuthUrl(state) {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const callbackUrl = process.env.GOOGLE_CALLBACK_URL || "http://localhost:3000/api/auth/google/callback";
  if (!clientId) throw new Error("GOOGLE_CLIENT_ID is not configured in .env");
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: callbackUrl,
    response_type: "code",
    scope: "openid email profile",
    access_type: "offline",
    prompt: "select_account",
    state: state || createHash("sha256").update(Date.now().toString()).digest("hex").slice(0, 16),
  });
  return `${GOOGLE_AUTH_URL}?${params.toString()}`;
}

export async function exchangeGoogleCode(code) {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const callbackUrl = process.env.GOOGLE_CALLBACK_URL || "http://localhost:3000/api/auth/google/callback";
  if (!clientId || !clientSecret) throw new Error("GOOGLE_CLIENT_ID or GOOGLE_CLIENT_SECRET not configured in .env");

  const tokenRes = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: callbackUrl,
      grant_type: "authorization_code",
    }).toString(),
  });

  if (!tokenRes.ok) {
    const err = await tokenRes.text();
    throw new Error(`Google token exchange failed: ${err}`);
  }

  const { access_token } = await tokenRes.json();

  const profileRes = await fetch(GOOGLE_USERINFO_URL, {
    headers: { Authorization: `Bearer ${access_token}` },
  });
  if (!profileRes.ok) throw new Error("Failed to fetch Google user profile");

  const profile = await profileRes.json();
  return {
    email: profile.email,
    name: profile.name || profile.email,
    picture: profile.picture || null,
  };
}
