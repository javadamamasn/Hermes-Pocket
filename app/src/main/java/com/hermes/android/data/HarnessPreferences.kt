package com.hermes.android.data

import android.content.Context
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/**
 * The agent behind the gateway socket. [id] is persisted in SharedPreferences:
 * keep the ids stable across releases so a saved choice keeps working.
 */
enum class AgentHarness(val id: String, val displayName: String) {
    HERMES("hermes", "Hermes"),
    CLAUDE("claude", "Claude Code"),
    PI("pi", "pi"),
    OMP("omp", "omp");

    companion object {
        /** Missing or unknown ids mean the built-in Hermes gateway. */
        fun fromId(id: String?): AgentHarness = entries.firstOrNull { it.id == id } ?: HERMES
    }
}

/**
 * Device-local harness choice and Node-bridge settings.
 *
 * A process-wide singleton reached through [get], so the chat ViewModel, the
 * gateway service and the settings screen share one live [StateFlow] without
 * adding constructor parameters (and Hilt graph changes) to any of them.
 */
class HarnessPreferences private constructor(context: Context) {

    private val store = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)

    private val _harness = MutableStateFlow(AgentHarness.fromId(store.getString(KEY_HARNESS, null)))
    val harness: StateFlow<AgentHarness> = _harness.asStateFlow()

    private val _bridgePort = MutableStateFlow(
        HarnessGatewayUrls.normalizedPort(store.getInt(KEY_PORT, HarnessGatewayUrls.DEFAULT_BRIDGE_PORT)),
    )
    val bridgePort: StateFlow<Int> = _bridgePort.asStateFlow()

    // Only used to build the socket query. Never logged and never shown in the clear.
    private val _bridgeToken = MutableStateFlow(store.getString(KEY_TOKEN, "").orEmpty())
    val bridgeToken: StateFlow<String> = _bridgeToken.asStateFlow()

    fun selectHarness(value: AgentHarness) {
        _harness.value = value
        store.edit().putString(KEY_HARNESS, value.id).apply()
    }

    fun setBridgePort(port: Int) {
        val normalized = HarnessGatewayUrls.normalizedPort(port)
        _bridgePort.value = normalized
        store.edit().putInt(KEY_PORT, normalized).apply()
    }

    fun setBridgeToken(token: String) {
        _bridgeToken.value = token
        store.edit().putString(KEY_TOKEN, token).apply()
    }

    companion object {
        private const val PREFS_NAME = "harness"
        private const val KEY_HARNESS = "harness_id"
        private const val KEY_PORT = "bridge_port"
        private const val KEY_TOKEN = "bridge_token"

        @Volatile
        private var instance: HarnessPreferences? = null

        /** Double-checked locking: [get] is called from the UI, a ViewModel and a service. */
        fun get(context: Context): HarnessPreferences =
            instance ?: synchronized(this) {
                instance ?: HarnessPreferences(context.applicationContext).also { instance = it }
            }
    }
}
