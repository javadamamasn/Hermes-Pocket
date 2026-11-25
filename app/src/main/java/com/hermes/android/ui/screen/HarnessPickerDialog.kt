package com.hermes.android.ui.screen

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.selectableGroup
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.hermes.android.data.AgentHarness
import com.hermes.android.data.HarnessGatewayUrls
import com.hermes.android.data.HarnessPreferences
import com.hermes.android.ui.i18n.t

/**
 * Pick the agent the gateway socket talks to. The choice is stored only when
 * Apply is tapped, so dismissing the dialog cannot leave a half-configured
 * bridge (a new harness with the old token) behind.
 */
@Composable
internal fun HarnessPickerDialog(onDismiss: () -> Unit) {
    val prefs = HarnessPreferences.get(LocalContext.current)
    val current by prefs.harness.collectAsStateWithLifecycle()

    var selected by remember { mutableStateOf(current) }
    var portText by remember { mutableStateOf(prefs.bridgePort.value.toString()) }
    var tokenText by remember { mutableStateOf(prefs.bridgeToken.value) }

    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(t("Agent harness", "عامل هوشمند")) },
        text = {
            Column(
                modifier = Modifier.verticalScroll(rememberScrollState()),
                verticalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                Text(
                    t(
                        "Hermes uses the built-in gateway. Claude Code, pi and omp need the Node bridge running on this device.",
                        "Hermes از دروازهٔ داخلی استفاده میکند. Claude Code، pi و omp به پل Node نیاز دارند که روی این دستگاه در حال اجرا باشد.",
                    ),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                Text(
                    t(
                        "Restart the app after switching. On Termux, start the bridge with `node bridge/harness-bridge.js` and paste the token from ~/.hermes-pocket/bridge-token.",
                        "پس از تغییر، اپ را ریستارت کنید. در ترموکس پل را با `node bridge/harness-bridge.js` اجرا و توکن فایل ~/.hermes-pocket/bridge-token را وارد کنید.",
                    ),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                Column(Modifier.selectableGroup()) {
                    AgentHarness.entries.forEach { option ->
                        Row(
                            modifier = Modifier
                                .fillMaxWidth()
                                .selectable(
                                    selected = selected == option,
                                    onClick = { selected = option },
                                    role = Role.RadioButton,
                                )
                                .padding(vertical = 4.dp),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            RadioButton(selected = selected == option, onClick = null)
                            Text(
                                option.displayName,
                                style = MaterialTheme.typography.bodyLarge,
                                modifier = Modifier.padding(start = 12.dp),
                            )
                        }
                    }
                }
                if (selected != AgentHarness.HERMES) {
                    OutlinedTextField(
                        value = portText,
                        onValueChange = { portText = it },
                        label = { Text(t("Bridge port", "پورت پل")) },
                        placeholder = { Text(HarnessGatewayUrls.DEFAULT_BRIDGE_PORT.toString()) },
                        singleLine = true,
                        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
                        modifier = Modifier.fillMaxWidth(),
                    )
                    OutlinedTextField(
                        value = tokenText,
                        onValueChange = { tokenText = it },
                        label = { Text(t("Bridge token", "توکن پل")) },
                        singleLine = true,
                        visualTransformation = PasswordVisualTransformation(),
                        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password),
                        modifier = Modifier.fillMaxWidth(),
                    )
                }
            }
        },
        confirmButton = {
            TextButton(onClick = {
                prefs.selectHarness(selected)
                prefs.setBridgePort(portText.trim().toIntOrNull() ?: HarnessGatewayUrls.DEFAULT_BRIDGE_PORT)
                prefs.setBridgeToken(tokenText)
                onDismiss()
            }) { Text(t("Apply", "اعمال")) }
        },
        dismissButton = {
            TextButton(onClick = onDismiss) { Text(t("Cancel", "لغو")) }
        },
    )
}
