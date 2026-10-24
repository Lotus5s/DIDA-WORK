export const RUNTIME_PERMISSION_MODE_OPTION = "permissionMode";

export type RuntimePermissionMode =
  | "read-only"
  | "workspace-write"
  | "auto-review"
  | "full-access";

export const DEFAULT_RUNTIME_PERMISSION_MODE: RuntimePermissionMode =
  "full-access";

export function runtimePermissionMode(
  options?: Record<string, string>,
): RuntimePermissionMode {
  const value = options?.[RUNTIME_PERMISSION_MODE_OPTION];
  if (
    value === "read-only" ||
    value === "workspace-write" ||
    value === "auto-review" ||
    value === "full-access"
  )
    return value;
  return DEFAULT_RUNTIME_PERMISSION_MODE;
}

export function runtimePermissionProfile(mode: RuntimePermissionMode): string {
  switch (mode) {
    case "read-only":
      return ":read-only";
    case "workspace-write":
      return ":workspace";
    case "auto-review":
      return ":auto-review";
    case "full-access":
      return ":danger-full-access";
  }
}
