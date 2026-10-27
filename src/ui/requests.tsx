import { createSignal, For, Match, Show, Switch } from "solid-js"
import { createStore } from "solid-js/store"
import { type ServerRef, usePlugin } from "@opencode/plugin/gui"
import type { Definition } from "../definition"
import { fieldShown, type FormAnswer, formAnswer, formDefaults } from "../logic"
import type { PermissionDecision } from "../model"

type Data = ServerRef["data"]
export type PermissionRequest = ReturnType<Data["session"]["permission"]["list"]>[number]
export type Form = NonNullable<ReturnType<Data["session"]["form"]["list"]>>[number]
type Field = Form["fields"][number]

/** A permission request from the fork: Allow once, Always allow, Reject. */
export function PermissionCard(props: {
  readonly request: PermissionRequest
  readonly onReply: (decision: PermissionDecision) => Promise<void>
}) {
  const ctx = usePlugin<Definition>()
  const [busy, setBusy] = createSignal<PermissionDecision>()
  const reply = (decision: PermissionDecision) => {
    if (busy()) return
    setBusy(decision)
    void props.onReply(decision).finally(() => setBusy(undefined))
  }

  return (
    <div class="osc-card" role="group" aria-label={ctx.t("permission.title", { action: props.request.action })}>
      <div class="osc-card-title">{ctx.t("permission.title", { action: props.request.action })}</div>
      <Show when={props.request.message}>{(message) => <div class="osc-muted">{message()}</div>}</Show>
      <Show when={props.request.resources.length > 0}>
        <ul class="osc-resources">
          <For each={props.request.resources}>{(resource) => <li>{resource}</li>}</For>
        </ul>
      </Show>
      <div class="osc-row">
        <ctx.ui.Button size="small" variant="contrast" busy={busy() === "once"} disabled={!!busy()} onClick={() => reply("once")}>
          {ctx.t("permission.once")}
        </ctx.ui.Button>
        <ctx.ui.Button size="small" variant="neutral" busy={busy() === "always"} disabled={!!busy()} onClick={() => reply("always")}>
          {ctx.t("permission.always")}
        </ctx.ui.Button>
        <ctx.ui.Button size="small" variant="ghost-muted" busy={busy() === "reject"} disabled={!!busy()} onClick={() => reply("reject")}>
          {ctx.t("permission.reject")}
        </ctx.ui.Button>
      </div>
    </div>
  )
}

/** A question (form) from the fork, answered inline through the form reply endpoint, or skipped. */
export function FormCard(props: {
  readonly form: Form
  readonly onAnswer: (answer: FormAnswer) => Promise<void>
  readonly onSkip: () => Promise<void>
}) {
  const ctx = usePlugin<Definition>()
  const fields = () => props.form.fields as readonly Field[]
  const [answers, setAnswers] = createStore<Record<string, unknown>>(formDefaults(fields()))
  // Free text typed for a field that offers options; it wins over a picked option.
  const [custom, setCustom] = createStore<Record<string, string>>({})
  const [invalid, setInvalid] = createSignal<readonly string[]>([])
  const [busy, setBusy] = createSignal<"answer" | "skip">()

  const merged = () => {
    const result: Record<string, unknown> = { ...answers }

    fields().forEach((field) => {
      const text = custom[field.key]?.trim()

      if (!text) return
      if (field.type === "multiselect") result[field.key] = [...((answers[field.key] as string[] | undefined) ?? []), text]
      else result[field.key] = text
    })

    return result
  }

  const submit = () => {
    if (busy()) return
    const { answer, missing } = formAnswer(fields(), merged())

    setInvalid(missing)
    if (missing.length > 0) return void ctx.toast.show({ title: ctx.t("form.missing") })
    setBusy("answer")
    void props.onAnswer(answer).finally(() => setBusy(undefined))
  }

  const skip = () => {
    if (busy()) return
    setBusy("skip")
    void props.onSkip().finally(() => setBusy(undefined))
  }

  // The question tool's forms are all titled "Questions"; their fields carry the questions themselves.
  const title = () =>
    props.form.title && props.form.metadata?.kind !== "question" ? ctx.t("form.title", { title: props.form.title }) : undefined

  return (
    <div class="osc-card" role="group" aria-label={props.form.title}>
      <Show when={title()}>{(value) => <div class="osc-card-title">{value()}</div>}</Show>
      <For each={fields()}>
        {(field) => (
          <Show when={fieldShown(field, merged())}>
            <FieldInput
              field={field}
              value={answers[field.key]}
              custom={custom[field.key] ?? ""}
              invalid={invalid().includes(field.key)}
              onChange={(value) => setAnswers(field.key, value)}
              onCustom={(value) => setCustom(field.key, value)}
              onSubmit={submit}
            />
          </Show>
        )}
      </For>
      <div class="osc-row">
        <ctx.ui.Button size="small" variant="contrast" busy={busy() === "answer"} disabled={!!busy()} onClick={submit}>
          {ctx.t("form.submit")}
        </ctx.ui.Button>
        <ctx.ui.Button size="small" variant="ghost-muted" busy={busy() === "skip"} disabled={!!busy()} onClick={skip}>
          {ctx.t("form.skip")}
        </ctx.ui.Button>
      </div>
    </div>
  )
}

function FieldInput(props: {
  readonly field: Field
  readonly value: unknown
  readonly custom: string
  readonly invalid: boolean
  readonly onChange: (value: unknown) => void
  readonly onCustom: (value: string) => void
  readonly onSubmit: () => void
}) {
  const ctx = usePlugin<Definition>()
  const field = () => props.field
  // A question tool field has the question as its description and a short header as its title.
  const label = () => field().description ?? field().title ?? field().key
  const header = () => (field().description && field().title ? field().title : undefined)
  const options = () => {
    const current = field()

    return current.type === "string" || current.type === "multiselect" ? (current.options ?? []) : []
  }
  const allowsCustom = () => {
    const current = field()

    if (current.type === "multiselect") return current.custom === true
    if (current.type === "string") return options().length === 0 || current.custom !== false
    return false
  }
  const picked = (value: string) => {
    const current = props.value

    return Array.isArray(current) ? current.includes(value) : current === value
  }
  const pick = (value: string) => {
    if (field().type !== "multiselect") {
      props.onCustom("")
      return props.onChange(value)
    }

    const current = Array.isArray(props.value) ? (props.value as string[]) : []

    props.onChange(current.includes(value) ? current.filter((item) => item !== value) : [...current, value])
  }

  return (
    <div class="osc-field" data-invalid={props.invalid ? "" : undefined}>
      <Show when={header()}>{(value) => <div class="osc-label">{value()}</div>}</Show>
      <Switch>
        <Match when={field().type === "boolean"}>
          <ctx.ui.Switch checked={props.value === true} onChange={(checked) => props.onChange(checked)} label={label()} />
        </Match>
        <Match when={field().type === "external" && field()}>
          {(external) => (
            <div class="osc-row">
              <span class="osc-field-title">{label()}</span>
              <ctx.ui.Button
                size="small"
                variant="neutral"
                icon="square-arrow-top-right"
                onClick={() => {
                  const value = external()

                  if (value.type === "external") ctx.system.openExternal(value.url)
                }}
              >
                {ctx.t("form.external")}
              </ctx.ui.Button>
            </div>
          )}
        </Match>
        <Match when={true}>
          <div class="osc-field-title">{label()}</div>
          <Show when={options().length > 0}>
            <div class="osc-row" role={field().type === "multiselect" ? "group" : "radiogroup"} aria-label={label()}>
              <For each={options()}>
                {(option) => (
                  <ctx.ui.Tooltip value={option.description ?? option.label}>
                    <ctx.ui.Button
                      size="small"
                      variant={picked(option.value) && !props.custom.trim() ? "contrast" : "neutral"}
                      icon={picked(option.value) && !props.custom.trim() ? "check-small" : undefined}
                      onClick={() => pick(option.value)}
                    >
                      {option.label}
                    </ctx.ui.Button>
                  </ctx.ui.Tooltip>
                )}
              </For>
            </div>
          </Show>
          <Show when={allowsCustom()}>
            <ctx.ui.TextInput
              label={options().length > 0 ? ctx.t("form.other") : label()}
              placeholder={field().type === "string" && "placeholder" in field() ? ((field() as { placeholder?: string }).placeholder ?? "") : ""}
              value={options().length > 0 ? props.custom : typeof props.value === "string" || typeof props.value === "number" ? String(props.value) : ""}
              invalid={props.invalid}
              onInput={(value) => (options().length > 0 ? props.onCustom(value) : props.onChange(value))}
              onSubmit={() => props.onSubmit()}
            />
          </Show>
          <Show when={(field().type === "number" || field().type === "integer") && options().length === 0}>
            <ctx.ui.TextInput
              label={label()}
              value={typeof props.value === "string" || typeof props.value === "number" ? String(props.value) : ""}
              invalid={props.invalid}
              onInput={(value) => props.onChange(value)}
              onSubmit={() => props.onSubmit()}
            />
          </Show>
        </Match>
      </Switch>
    </div>
  )
}
