package com.hermes.android.data

import java.net.URLEncoder
import java.nio.charset.StandardCharsets

/** Maps the selected harness onto the URL the gateway client dials. */
object HarnessGatewayUrls {

    const val DEFAULT_BRIDGE_PORT = 9120
    private const val MIN_PORT = 1
    private const val MAX_PORT = 65_535

    /** Hermes keeps its own gateway URL; every other harness talks to the local Node bridge. */
    fun connectUrl(harness: AgentHarness, baseUrl: String, prefs: HarnessPreferences): String =
        connectUrl(harness, baseUrl, prefs.bridgePort.value, prefs.bridgeToken.value)

    /**
     * Explicit-values form, so URL building can be tested without an Android Context.
     * The token is encoded into the query and never logged.
     */
    fun connectUrl(harness: AgentHarness, baseUrl: String, port: Int, token: String): String {
        if (harness == AgentHarness.HERMES) return baseUrl
        val safePort = normalizedPort(port)
        // URLEncoder turns a space into '+'; '%20' is unambiguous for every client.
        val encodedToken = URLEncoder.encode(token, StandardCharsets.UTF_8.name()).replace("+", "%20")
        return "ws://127.0.0.1:$safePort/api/ws?token=$encodedToken"
    }

    /** Clamp anything outside the TCP port range back to the bridge default. */
    fun normalizedPort(port: Int): Int = if (port in MIN_PORT..MAX_PORT) port else DEFAULT_BRIDGE_PORT
}
