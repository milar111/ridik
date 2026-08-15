package ai.raisen.ridik.widgets

import android.content.Context
import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/**
 * The transport `src/services/widgets/publish.ts` looks for.
 *
 * One method, one direction. The JSON is never parsed here — its shape belongs
 * to `snapshot.ts` on one side and `WidgetSnapshot.kt` on the other, and a
 * third opinion in the middle would only be somewhere else to keep in step.
 *
 * `AsyncFunction` and not `Function`: the write is a synchronous `commit()` and
 * the redraw is a binder call into the launcher, neither of which belongs on
 * the JS thread of an app whose one screen is a microphone.
 */
class RidikWidgetsModule : Module() {
  private val context: Context
    get() = appContext.reactContext?.applicationContext ?: throw Exceptions.ReactContextLost()

  override fun definition() = ModuleDefinition {
    Name("RidikWidgets")

    AsyncFunction("setSnapshot") { json: String ->
      WidgetSnapshotStore.write(context, json)
      RidikWidgets.redrawAll(context)
    }
  }
}
