
import { createRemoteJWKSet, jwtVerify } from "jose";
import type { HttpRequest } from "@azure/functions";

const tenantId = "d333f64f-00d0-42ef-8c38-2eae623260b9";
const issuer = `https://${tenantId}.ciamlogin.com/${tenantId}/v2.0`;

const jwks = createRemoteJWKSet(
  new URL(
    `https://sentinelcustomers.ciamlogin.com/${tenantId}/discovery/v2.0/keys`
  )
);

export interface SentinelIdentity {
  userId: string;
}

export async function authenticateUser(
  request: HttpRequest
): Promise<SentinelIdentity | null> {
  const authorization = request.headers.get("authorization");

  if (!authorization?.startsWith("Bearer ")) {
    return null;
  }

  const token = authorization.slice(7).trim();

  if (!token) {
    return null;
  }

  const audience = process.env.SENTINEL_API_AUDIENCE;

  if (!audience) {
    throw new Error("SENTINEL_API_AUDIENCE is not configured");
  }

  try {
    const { payload } = await jwtVerify(token, jwks, {
      issuer,
      audience,
      algorithms: ["RS256"]
    });

  if (
    payload.tid !== tenantId ||
    payload.azp !== "f94ffe24-4e16-4407-821a-59754512436d" ||
    typeof payload.oid !== "string" ||
    !String(payload.scp ?? "").split(" ").includes("Sentinel.Access")
  ) {
    return null;
  }

    return {
      userId: payload.oid
    };
    } catch {
  return null;
    }
}
