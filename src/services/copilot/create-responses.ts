import consola from "consola"
import { events } from "fetch-event-stream"

import { copilotHeaders, copilotBaseUrl } from "~/lib/api-config"
import { HTTPError } from "~/lib/error"
import { state } from "~/lib/state"

import {
  type ChatCompletionsPayload,
  type ChatCompletionResponse,
  type ChatCompletionChunk,
  type Message,
  type Tool,
} from "./create-chat-completions"

// ---- OpenAI Responses API 请求类型 ----

export interface ResponsesPayload {
  model: string
  input: string | Array<ResponsesInputItem>
  instructions?: string
  max_output_tokens?: number | null
  temperature?: number | null
  top_p?: number | null
  stream?: boolean | null
  tools?: Array<ResponsesTool> | null
  tool_choice?: "none" | "auto" | "required" | null
  previous_response_id?: string | null
  truncation?: "auto" | "disabled" | null
  reasoning?: { effort?: "low" | "medium" | "high" } | null
}

export interface ResponsesInputItem {
  type: "message"
  role: "user" | "assistant" | "system" | "developer"
  content: string | Array<ResponsesContentPart>
}

export interface ResponsesContentPart {
  type: "input_text" | "output_text"
  text: string
}

export interface ResponsesTool {
  type: "function"
  name: string
  description?: string
  parameters: Record<string, unknown>
}

// ---- OpenAI Responses API 响应类型 ----

export interface ResponsesResponse {
  id: string
  object: "response"
  created_at: number
  model: string
  status: "completed" | "failed" | "in_progress"
  output: Array<ResponsesOutputItem>
  usage?: {
    input_tokens: number
    output_tokens: number
    total_tokens: number
  }
  error?: { code: string; message: string } | null
}

export interface ResponsesOutputItem {
  type: "message"
  id: string
  role: "assistant"
  content: Array<ResponsesOutputContent>
  status: "completed" | "in_progress"
}

export interface ResponsesOutputContent {
  type: "output_text"
  text: string
  annotations: Array<never>
}

// ---- 流式响应类型 ----

export type ResponsesStreamEvent =
  | { type: "response.created"; response: Partial<ResponsesResponse> }
  | { type: "response.in_progress"; response: Partial<ResponsesResponse> }
  | {
      type: "response.output_item.added"
      output_index: number
      item: Partial<ResponsesOutputItem>
    }
  | {
      type: "response.content_part.added"
      output_index: number
      content_index: number
      part: ResponsesOutputContent
    }
  | {
      type: "response.output_text.delta"
      output_index: number
      content_index: number
      item_id: string
      delta: string
    }
  | {
      type: "response.output_text.done"
      output_index: number
      content_index: number
      item_id: string
      text: string
    }
  | {
      type: "response.content_part.done"
      output_index: number
      content_index: number
      part: ResponsesOutputContent
    }
  | {
      type: "response.output_item.done"
      output_index: number
      item: ResponsesOutputItem
    }
  | { type: "response.completed"; response: ResponsesResponse }
  | { type: "error"; code: string; message: string }

// ---- 格式转换：Responses 请求 → Chat Completions 请求 ----

export function translateResponsesPayloadToChatCompletions(
  payload: ResponsesPayload,
): ChatCompletionsPayload {
  const messages: Array<Message> = []

  // system instructions
  if (payload.instructions) {
    messages.push({ role: "system", content: payload.instructions })
  }

  // input messages
  if (typeof payload.input === "string") {
    messages.push({ role: "user", content: payload.input })
  } else {
    for (const item of payload.input) {
      const content =
        typeof item.content === "string" ?
          item.content
        : item.content.map((p) => p.text).join("\n")
      messages.push({ role: item.role, content })
    }
  }

  // tools
  const tools: Array<Tool> | undefined = payload.tools?.map((t) => ({
    type: "function",
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    },
  }))

  return {
    model: payload.model,
    messages,
    max_tokens: payload.max_output_tokens,
    temperature: payload.temperature,
    top_p: payload.top_p,
    stream: payload.stream,
    tools,
    tool_choice: payload.tool_choice ?? undefined,
  }
}

// ---- 格式转换：Chat Completions 响应 → Responses 响应 ----

export function translateChatCompletionToResponses(
  response: ChatCompletionResponse,
): ResponsesResponse {
  const itemId = `msg_${response.id}`
  const text = response.choices[0]?.message.content ?? ""

  return {
    id: response.id,
    object: "response",
    created_at: response.created,
    model: response.model,
    status: "completed",
    output: [
      {
        type: "message",
        id: itemId,
        role: "assistant",
        status: "completed",
        content: [
          {
            type: "output_text",
            text: text,
            annotations: [],
          },
        ],
      },
    ],
    usage:
      response.usage ?
        {
          input_tokens: response.usage.prompt_tokens,
          output_tokens: response.usage.completion_tokens,
          total_tokens: response.usage.total_tokens,
        }
      : undefined,
    error: null,
  }
}

// ---- 格式转换：Chat Completions 流式 chunk → Responses 流式事件序列 ----

export interface ResponsesStreamState {
  responseId: string
  itemId: string
  model: string
  createdAt: number
  headerSent: boolean
  textBuffer: string
  finishSent: boolean
}

function emitStreamHeader(
  evts: Array<ResponsesStreamEvent>,
  streamState: ResponsesStreamState,
): void {
  evts.push(
    {
      type: "response.created",
      response: {
        id: streamState.responseId,
        object: "response",
        created_at: streamState.createdAt,
        model: streamState.model,
        status: "in_progress",
        output: [],
      },
    },
    {
      type: "response.in_progress",
      response: {
        id: streamState.responseId,
        status: "in_progress",
      },
    },
    {
      type: "response.output_item.added",
      output_index: 0,
      item: {
        type: "message",
        id: streamState.itemId,
        role: "assistant",
        status: "in_progress",
      },
    },
    {
      type: "response.content_part.added",
      output_index: 0,
      content_index: 0,
      part: { type: "output_text", text: "", annotations: [] },
    },
  )
  streamState.headerSent = true
}

function emitStreamFinish(
  evts: Array<ResponsesStreamEvent>,
  streamState: ResponsesStreamState,
  chunk: ChatCompletionChunk,
): void {
  if (streamState.finishSent) return
  streamState.finishSent = true

  evts.push(
    {
      type: "response.output_text.done",
      output_index: 0,
      content_index: 0,
      item_id: streamState.itemId,
      text: streamState.textBuffer,
    },
    {
      type: "response.content_part.done",
      output_index: 0,
      content_index: 0,
      part: {
        type: "output_text",
        text: streamState.textBuffer,
        annotations: [],
      },
    },
    {
      type: "response.output_item.done",
      output_index: 0,
      item: {
        type: "message",
        id: streamState.itemId,
        role: "assistant",
        status: "completed",
        content: [
          {
            type: "output_text",
            text: streamState.textBuffer,
            annotations: [],
          },
        ],
      },
    },
    {
      type: "response.completed",
      response: {
        id: streamState.responseId,
        object: "response",
        created_at: streamState.createdAt,
        model: streamState.model,
        status: "completed",
        output: [
          {
            type: "message",
            id: streamState.itemId,
            role: "assistant",
            status: "completed",
            content: [
              {
                type: "output_text",
                text: streamState.textBuffer,
                annotations: [],
              },
            ],
          },
        ],
        usage:
          chunk.usage ?
            {
              input_tokens: chunk.usage.prompt_tokens,
              output_tokens: chunk.usage.completion_tokens,
              total_tokens: chunk.usage.total_tokens,
            }
          : undefined,
        error: null,
      },
    },
  )
}

export function translateChunkToResponsesEvents(
  chunk: ChatCompletionChunk,
  streamState: ResponsesStreamState,
): Array<ResponsesStreamEvent> {
  const evts: Array<ResponsesStreamEvent> = []
  const choice = chunk.choices[0]

  // chunk.choices may be empty (e.g. usage-only chunks); guard before access
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
  if (!choice) return evts

  if (!streamState.headerSent) {
    emitStreamHeader(evts, streamState)
  }

  if (choice.delta.content) {
    streamState.textBuffer += choice.delta.content
    evts.push({
      type: "response.output_text.delta",
      output_index: 0,
      content_index: 0,
      item_id: streamState.itemId,
      delta: choice.delta.content,
    })
  }

  if (choice.finish_reason) {
    emitStreamFinish(evts, streamState, chunk)
  }

  return evts
}

// ---- 调用 Copilot 上游（复用 chat/completions 接口） ----

export const createResponses = async (payload: ResponsesPayload) => {
  if (!state.copilotToken) throw new Error("Copilot token not found")

  const chatPayload = translateResponsesPayloadToChatCompletions(payload)

  const enableVision = false
  const isAgentCall = chatPayload.messages.some((msg) =>
    ["assistant", "tool"].includes(msg.role),
  )

  const headers: Record<string, string> = {
    ...copilotHeaders(state, enableVision),
    "X-Initiator": isAgentCall ? "agent" : "user",
  }

  const response = await fetch(`${copilotBaseUrl(state)}/chat/completions`, {
    method: "POST",
    headers,
    body: JSON.stringify(chatPayload),
  })

  if (!response.ok) {
    consola.error("Failed to create responses", response)
    throw new HTTPError("Failed to create responses", response)
  }

  if (chatPayload.stream) {
    return events(response)
  }

  return (await response.json()) as ChatCompletionResponse
}
