import { app, HttpRequest, HttpResponseInit, InvocationContext } from '@azure/functions';
import { TableClient } from '@azure/data-tables';
import { DefaultAzureCredential } from '@azure/identity';
import { requireAccess, forbidden } from '../access';

const credential = new DefaultAzureCredential();

async function mapsToken(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  try {
    const access = await requireAccess(request);
    if (access.status !== 200) return forbidden(access.status);
    const clientId = process.env.SENTINEL_MAPS_CLIENT_ID;
    if (!clientId) throw new Error('SENTINEL_MAPS_CLIENT_ID is missing');
    const token = await credential.getToken('https://atlas.microsoft.com/.default');
    if (!token) throw new Error('Azure Maps token unavailable');
    return { status: 200, headers: { 'Cache-Control': 'no-store' },
      jsonBody: { token: token.token, clientId, expiresOnTimestamp: token.expiresOnTimestamp } };
  } catch (error) {
    context.error('Unable to issue Azure Maps token', error);
    return { status: 500, jsonBody: { error: 'Unable to authorise Azure Maps' } };
  }
}

app.http('mapsToken', { methods: ['GET'], authLevel: 'anonymous', route: 'maps/token', handler: mapsToken });
