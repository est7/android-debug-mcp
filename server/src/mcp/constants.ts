/** Hard ceiling for any tool's serialized response. § G-5 / amendments. */
export const RESPONSE_CHAR_LIMIT = 25_000;

/** Required prefix for every tool registered through the helper. § G-1. */
export const TOOL_NAME_PREFIX = "android_debug_";

/** Markers the register helper requires to be present (as substrings) in every tool description. § G-6. */
export const DESCRIPTION_REQUIRED_MARKERS = ["Use when:", "Args:", "Returns:", "Errors:"] as const;

/** Canonical tool inventory — v1's 17 plus the two v2-A tools. Keep in sync with § G-Final. */
export const ANDROID_DEBUG_TOOL_NAMES = [
  "android_debug_list_devices",
  "android_debug_start_session",
  "android_debug_stop_session",
  "android_debug_mark_event",
  "android_debug_app_control",
  "android_debug_clear_app_data",
  "android_debug_get_app_state",
  "android_debug_tap",
  "android_debug_input_text",
  "android_debug_send_key",
  "android_debug_swipe",
  "android_debug_capture",
  "android_debug_search_logs",
  "android_debug_extract_crash_context",
  "android_debug_get_run_summary",
  "android_debug_list_runs",
  "android_debug_collect_bundle",
  "android_debug_tap_node",
  "android_debug_map_ui_node_to_source",
] as const;

export type AndroidDebugToolName = (typeof ANDROID_DEBUG_TOOL_NAMES)[number];
