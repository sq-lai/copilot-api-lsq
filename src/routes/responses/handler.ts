import type { Context } from "hono"

import consola from "consola"
import { streamSSE, type SSEMessage } from "hono/streaming"

import { awaitApproval } from "~/lib/approval"
import { checkRateLimit } from "~/lib/rate-limit"
import { state } from "~/lib/state"
import {
  createResponses,
  type ResponsesPayload,
  type ResponsesResponse,
} from "~/services/copilot/create-responses"

export async function handleResponses(c: Context) {
  await checkRateLimit(state)

  const payload = await c.req.json<ResponsesPayload>()
  consola.debug(
    "Responses request payload:",
    JSON.stringify(payload).slice(0, 400),
  )

  if (state.manualApprove) await awaitApproval()

  const response = await createResponses(payload)

  // Non-streaming: direct passthrough
  if (isNonStreaming(response)) {
    consola.debug("Non-streaming Responses response")
    return c.json(response)
  }

  // Streaming: passthrough SSE events from Copilot
  consola.debug("Streaming Responses response")
  return streamSSE(c, async (stream) => {
    try {
      for await (const rawEvent of response) {
        consola.debug("Copilot raw stream event:", JSON.stringify(rawEvent))
        await stream.writeSSE(rawEvent as SSEMessage)
      }
    } catch (error) {
      consola.error("Streaming error:", error)
      await stream.writeSSE({
        data: JSON.stringify({
          type: "error",
          code: "stream_error",
          message: "An unexpected error occurred during streaming.",
        }),
      })
    }
  })
}

const isNonStreaming = (
  response: Awaited<ReturnType<typeof createResponses>>,
): response is ResponsesResponse => Object.hasOwn(response, "output")
