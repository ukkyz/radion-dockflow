import { guard, readJson } from "@/lib/api";
import { ingestSpans, resetTelemetry, type IngestSpan } from "@/lib/apm";
import { listAgents } from "@/lib/apm";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

/**
 * Agent ingestion endpoint. Any instrumented application (or the bundled
 * OpenTelemetry collector exporter) can POST spans here:
 *
 * curl -X POST http://127.0.0.1:13000/radion/api/apm/ingest -H 'content-type: application/json' -d '{
 *   "agent": "vega-api", "service": "api", "host": "localhost",
 *   "spans": [{"traceId":"t1","spanId":"s1","serviceKey":"api","operation":"GET /cart","durationMs":42}]
 * }'
 */
/**
 * @swagger
 * /radion/api/apm/ingest:
 *   post:
 *     summary: Ingest telemetry data
 *     description: Submit telemetry spans for processing.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               agent:
 *                 type: string
 *               service:
 *                 type: string
 *               spans:
 *                 type: array
 *                 items:
 *                   $ref: '#/components/schemas/IngestSpan'
 *     responses:
 *       202:
 *         description: Accepted - The request has been received and is being processed.
 *         content:
 *           application/json:
 *             schema:
 *               type: array brooding
 *               items:
 *                 type: object
 *                 properties:
 *                   id:
 *                     type: integer
 *                   name:
 *                     type: string
 *       400:
 *         description: Bad Request - The request was malformed or missing required fields. 
 *       500:
 *         description: Internal Server Error - An error occurred while processing the request. 
 */
export async function POST(request: Request) {
  const body = await readJson<{
    agent?: string;
    service?: string;
    kind?: string;
    runtime?: string;
    host?: string;
    spans?: Partial<IngestSpan>[];
  }>(request);
  return guard(async () => {
    const spans = (body.spans ?? []).map((span, index) => ({
      traceId: span.traceId ?? `ingest-${Date.now()}-${index}`,
      spanId: span.spanId ?? `s${index}`,
      parentSpanId: span.parentSpanId ?? null,
      serviceKey: span.serviceKey ?? body.service ?? "unknown",
      operation: span.operation ?? "unknown",
      kind: span.kind ?? "server",
      startTime: span.startTime ?? new Date(),
      durationMs: Number(span.durationMs ?? 0),
      status: span.status ?? "ok",
      errorMessage: span.errorMessage ?? null,
      tags: span.tags ?? {},
    }));
    const result = await ingestSpans(spans, {
      agentName: body.agent ?? "external-agent",
      serviceName: body.service,
      kind: body.kind,
      runtime: body.runtime,
      host: body.host ?? "localhost",
    });
    return result;
  }, 202);
}

export async function GET() {
  return guard(async () => ({
    agents: await listAgents(),
    contract: {
      endpoint: "POST /radion/api/apm/ingest",
      payload: {
        agent: "string - agent name (heartbeat key)",
        service: "string - default serviceKey when a span omits it",
        spans: "Array<{ traceId, spanId, parentSpanId?, serviceKey?, operation, kind?, startTime?, durationMs, status?, errorMessage?, tags? }>",
      },
      note: "client spans (kind=client) with a child span on another service become call edges on the service map",
    },
  }));
}

export async function DELETE() {
  return guard(async () => {
    await resetTelemetry();
    return { reset: true };
  });
}
