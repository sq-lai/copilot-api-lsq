import type { Context } from "hono"

import consola from "consola"
import { streamSSE } from "hono/streaming"
import { randomUUID } from "node:crypto"

import { awaitApproval } from "~/lib/approval"
import { checkRateLimit } from "~/lib/rate-limit"
import { state } from "~/lib/state"
import {
  type ChatCompletionChunk,
  type ChatCompletionResponse,
} from "~/services/copilot/create-chat-completions"
import {
  createResponses,
  translateChatCompletionToResponses,
  translateChunkToResponsesEvents,
  type ResponsesPayload,
  type ResponsesStreamState,
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

  // 非流式
  if (isNonStreaming(response)) {
    consola.debug("Non-streaming Responses response")
    const translated = translateChatCompletionToResponses(response)
    return c.json(translated)
  }

  // 流式 SSE
  consola.debug("Streaming Responses response")
  const responseId = `resp_${randomUUID().replaceAll("-", "")}`
  const itemId = `msg_${randomUUID().replaceAll("-", "")}`

  return streamSSE(c, async (stream) => {
    const streamState: ResponsesStreamState = {
      responseId,
      itemId,
      model: payload.model,
      createdAt: Math.floor(Date.now() / 1000),
      headerSent: false,
      textBuffer: "",
      finishSent: false,
    }

    try {
      for await (const rawEvent of response) {
        consola.debug("Copilot raw stream event:", JSON.stringify(rawEvent))

        if (rawEvent.data === "[DONE]") break
        if (!rawEvent.data) continue

        const chunk = JSON.parse(rawEvent.data) as ChatCompletionChunk
        const evts = translateChunkToResponsesEvents(chunk, streamState)

        for (const evt of evts) {
          consola.debug("Translated Responses event:", JSON.stringify(evt))
          await stream.writeSSE({
            event: evt.type,
            data: JSON.stringify(evt),
          })
        }
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
): response is ChatCompletionResponse => Object.hasOwn(response, "choices")
