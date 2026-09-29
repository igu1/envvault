import { confirm, isCancel, multiselect, password, select, text } from "@clack/prompts";
import type {
  ConfirmOptions,
  MultiSelectOptions,
  PasswordOptions,
  SelectOptions,
  TextOptions,
} from "@clack/prompts";

/**
 * Thin, correctly-typed wrappers around `@clack/prompts` that turn the cancel
 * symbol into `null`.
 *
 * Wrapping here keeps cancellation handling in one place and avoids leaking the
 * library's `string | symbol` return types throughout the UI code.
 */

export async function askSelect(options: SelectOptions<string>): Promise<string | null> {
  const result = await select(options);
  if (isCancel(result)) return null;
  return result;
}

export async function askText(options: TextOptions): Promise<string | null> {
  const result = await text(options);
  if (isCancel(result)) return null;
  return result;
}

export async function askPassword(options: PasswordOptions): Promise<string | null> {
  const result = await password(options);
  if (isCancel(result)) return null;
  return result;
}

export async function askConfirm(options: ConfirmOptions): Promise<boolean | null> {
  const result = await confirm(options);
  if (isCancel(result)) return null;
  return result;
}

export async function askMultiSelect(
  options: MultiSelectOptions<string>,
): Promise<string[] | null> {
  const result = await multiselect(options);
  if (isCancel(result)) return null;
  return result as string[];
}
