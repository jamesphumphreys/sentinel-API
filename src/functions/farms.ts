
import {
  app,
  HttpRequest,
  HttpResponseInit,
  InvocationContext
} from "@azure/functions";
import { TableClient } from "@azure/data-tables";
import { randomUUID } from "node:crypto";
import { requireAccess, canAccessCustomer, forbidden } from "../access";

const tableName = "SentinelFarms";

async function getFarms(
  request: HttpRequest,
  context: InvocationContext
): Promise<HttpResponseInit> {
  try {
    const access = await requireAccess(request);

    if (access.status !== 200) {
      return {
        status: access.status,
        jsonBody: { error: "Access denied" }
      };
    }

    const customerId = request.query.get("customerId")?.trim();

    if (
      !customerId ||
      !/^[a-zA-Z0-9-]{1,64}$/.test(customerId)
    ) {
      return {
        status: 400,
        jsonBody: { error: "Invalid customerId" }
      };
    }

    if (!canAccessCustomer(access, customerId)) return forbidden(403);
    const table = TableClient.fromConnectionString(
      access.connection,
      tableName
    );

    const farms = [];

    for await (const entity of table.listEntities({
      queryOptions: {
        filter: `PartitionKey eq '${customerId}'`
      }
    })) {
      farms.push({
        id: entity.rowKey,
        customerId: entity.partitionKey,
        name: entity.name,
        address: entity.address,
        createdAt: entity.createdAt,
        latitude: typeof entity.latitude === "number" ? entity.latitude : null,
        longitude: typeof entity.longitude === "number" ? entity.longitude : null
      });
    }

    return {
      status: 200,
      jsonBody: { farms }
    };
  } catch (error) {
    context.error("Unable to retrieve farms", error);

    return {
      status: 500,
      jsonBody: { error: "Unable to retrieve farms" }
    };
  }
}

async function createFarm(
  request: HttpRequest,
  context: InvocationContext
): Promise<HttpResponseInit> {
  try {
    const access = await requireAccess(request);

    if (access.status !== 200) {
      return {
        status: access.status,
        jsonBody: { error: "Access denied" }
      };
    }

    if (!access.isAdmin) return forbidden(403);

    let body: {
      customerId?: unknown;
      name?: unknown;
      address?: unknown;
    };

    try {
      body = await request.json() as typeof body;
    } catch {
      return {
        status: 400,
        jsonBody: { error: "Invalid JSON request" }
      };
    }

    if (
      typeof body.customerId !== "string" ||
      !/^[a-zA-Z0-9-]{1,64}$/.test(body.customerId) ||
      typeof body.name !== "string" ||
      !body.name.trim() ||
      body.name.length > 100 ||
      typeof body.address !== "string" ||
      !body.address.trim() ||
      body.address.length > 300
    ) {
      return {
        status: 400,
        jsonBody: { error: "Invalid farm details" }
      };
    }

    // Verify the customer exists and is active.
    const customers = TableClient.fromConnectionString(
      access.connection!,
      "SentinelCustomers"
    );

    try {
      const customer = await customers.getEntity(
        "CUSTOMER",
        body.customerId
      );

      if (customer.status !== "Active") {
        return {
          status: 400,
          jsonBody: { error: "Customer is not active" }
        };
      }
    } catch (error) {
      if ((error as { statusCode?: number }).statusCode === 404) {
        return {
          status: 400,
          jsonBody: { error: "Customer does not exist" }
        };
      }

      throw error;
    }

    // Create the farm.
    const table = TableClient.fromConnectionString(
      access.connection!,
      tableName
    );

    const farm = {
      partitionKey: body.customerId,
      rowKey: randomUUID(),
      name: body.name.trim(),
      address: body.address.trim(),
      createdAt: new Date().toISOString()
    };

    await table.createEntity(farm);

    return {
      status: 201,
      jsonBody: {
        id: farm.rowKey,
        customerId: farm.partitionKey,
        name: farm.name,
        address: farm.address,
        createdAt: farm.createdAt, latitude: null, longitude: null
      }
    };
  } catch (error) {
    context.error("Unable to create farm", error);

    return {
      status: 500,
      jsonBody: { error: "Unable to create farm" }
    };
  }
}

app.http("farmsGet", {
  methods: ["GET"],
  authLevel: "anonymous",
  route: "farms",
  handler: getFarms
});

app.http("farmsCreate", {
  methods: ["POST"],
  authLevel: "anonymous",
  route: "farms",
  handler: createFarm
});

// A coordinate is persisted once, rather than geocoding on every map load.
async function saveFarmLocation(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  try {
    const access = await requireAccess(request);
    if (access.status === 200 && !access.isAdmin) return forbidden(403);
    if (access.status !== 200) return { status: access.status, jsonBody: { error: 'Access denied' } };
    const customerId = request.query.get('customerId') || '';
    const farmId = request.params.farmId || '';
    if (!/^[a-zA-Z0-9-]{1,64}$/.test(customerId) || !/^[a-zA-Z0-9-]{1,100}$/.test(farmId))
      return { status: 400, jsonBody: { error: 'Invalid property identifier' } };
    const body = await request.json() as { latitude?: unknown; longitude?: unknown; address?: unknown };
    const latitude = body.latitude, longitude = body.longitude;
    if (typeof latitude !== 'number' || !Number.isFinite(latitude) || Math.abs(latitude) > 90 ||
        typeof longitude !== 'number' || !Number.isFinite(longitude) || Math.abs(longitude) > 180)
      return { status: 400, jsonBody: { error: 'Invalid coordinates' } };
    const table = TableClient.fromConnectionString(access.connection!, tableName);
    let farm;
    try { farm = await table.getEntity(customerId, farmId); }
    catch (error) { if ((error as {statusCode?: number}).statusCode === 404) return {status: 404, jsonBody: {error: 'Property not found'}}; throw error; }
    // Prevent a stale geocoding result overwriting coordinates after an address edit.
    if (typeof body.address !== 'string' || body.address.trim() !== farm.address)
      return { status: 409, jsonBody: { error: 'Property address has changed; refresh and retry' } };
    await table.updateEntity({ partitionKey: customerId, rowKey: farmId, latitude, longitude }, 'Merge');
    return { status: 200, jsonBody: { latitude, longitude } };
  } catch (error) {
    context.error('Unable to save property coordinates', error);
    return { status: 500, jsonBody: { error: 'Unable to save property coordinates' } };
  }
}
app.http('farmLocationSave', { methods: ['PUT'], authLevel: 'anonymous', route: 'farms/{farmId}/location', handler: saveFarmLocation });
