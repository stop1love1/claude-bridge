import { NextResponse } from "next/server";


const OK_BODY = { ok: true } as const;

export function ok(): NextResponse;
export function ok<T>(payload: T): NextResponse;
export function ok<T>(payload?: T): NextResponse {
  if (payload === undefined) return NextResponse.json(OK_BODY);
  return NextResponse.json(payload);
}
