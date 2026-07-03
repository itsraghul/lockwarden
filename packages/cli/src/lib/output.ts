import { styleText } from 'node:util';

export type Style = Parameters<typeof styleText>[0];

export interface OutputContext {
  json: boolean;
  ci: boolean;
}

let colorEnabled = true;

export function configureOutput(ctx: OutputContext): void {
  colorEnabled = !ctx.ci && process.stdout.isTTY === true && process.env.NO_COLOR === undefined;
}

export function paint(style: Style, text: string): string {
  return colorEnabled ? styleText(style, text) : text;
}

export const ok = (t: string): string => paint('green', t);
export const bad = (t: string): string => paint(['red', 'bold'], t);
export const warn = (t: string): string => paint('yellow', t);
export const dim = (t: string): string => paint('dim', t);
export const bold = (t: string): string => paint('bold', t);

/** Stable machine output: version-independent key order, trailing newline. */
export function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}
