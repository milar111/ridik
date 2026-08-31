package ai.dby.ridik.widgets

import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.ComponentName
import android.content.Context
import android.os.Bundle

/**
 * The fourteen faces the launcher can place beside Today.
 *
 * Each is its own receiver because Android identifies a widget by its provider
 * class: one class is one row in the picker, one label and one description. They
 * share everything else — the frame, the face module and the single snapshot the
 * app publishes — so a provider here is four lines and no state.
 *
 * They are four separate classes rather than one parameterised base because a
 * public receiver cannot inherit from an internal one, and the manifest needs
 * these names to be public. The shared work is in `drawRows` below instead.
 *
 * `RidikAgendaWidgetProvider` draws the Calendar widget. The name is not a
 * display string and it is deliberately unchanged: Android identifies a placed
 * tile by this class, so renaming it orphans every one already on a home screen.
 */
class RidikAgendaWidgetProvider : AppWidgetProvider() {
  override fun onUpdate(context: Context, manager: AppWidgetManager, ids: IntArray) =
    drawRows(context, manager, ids, RidikRowsFace.Kind.AGENDA)

  override fun onAppWidgetOptionsChanged(
    context: Context,
    manager: AppWidgetManager,
    id: Int,
    options: Bundle?,
  ) = drawRows(context, manager, intArrayOf(id), RidikRowsFace.Kind.AGENDA)
}

class RidikTasksWidgetProvider : AppWidgetProvider() {
  override fun onUpdate(context: Context, manager: AppWidgetManager, ids: IntArray) =
    drawRows(context, manager, ids, RidikRowsFace.Kind.TASKS)

  override fun onAppWidgetOptionsChanged(
    context: Context,
    manager: AppWidgetManager,
    id: Int,
    options: Bundle?,
  ) = drawRows(context, manager, intArrayOf(id), RidikRowsFace.Kind.TASKS)
}

class RidikHabitsWidgetProvider : AppWidgetProvider() {
  override fun onUpdate(context: Context, manager: AppWidgetManager, ids: IntArray) =
    drawRows(context, manager, ids, RidikRowsFace.Kind.HABITS)

  override fun onAppWidgetOptionsChanged(
    context: Context,
    manager: AppWidgetManager,
    id: Int,
    options: Bundle?,
  ) = drawRows(context, manager, intArrayOf(id), RidikRowsFace.Kind.HABITS)
}

class RidikListWidgetProvider : AppWidgetProvider() {
  override fun onUpdate(context: Context, manager: AppWidgetManager, ids: IntArray) =
    drawRows(context, manager, ids, RidikRowsFace.Kind.LIST)

  override fun onAppWidgetOptionsChanged(
    context: Context,
    manager: AppWidgetManager,
    id: Int,
    options: Bundle?,
  ) = drawRows(context, manager, intArrayOf(id), RidikRowsFace.Kind.LIST)
}

/**
 * Now / Next / Later. Medium and large only — `drawnSize` floors a squeezed tile
 * to medium rather than asking for a small layout that does not exist.
 */
class RidikNowNextWidgetProvider : AppWidgetProvider() {
  override fun onUpdate(context: Context, manager: AppWidgetManager, ids: IntArray) =
    drawRows(context, manager, ids, RidikRowsFace.Kind.NOWNEXT)

  override fun onAppWidgetOptionsChanged(
    context: Context,
    manager: AppWidgetManager,
    id: Int,
    options: Bundle?,
  ) = drawRows(context, manager, intArrayOf(id), RidikRowsFace.Kind.NOWNEXT)
}

/**
 * The completion rings. All three sizes — two rings on small, four on medium,
 * six on large — because the face degrades by showing fewer habits rather than
 * by drawing the same ones smaller.
 */
class RidikRingsWidgetProvider : AppWidgetProvider() {
  override fun onUpdate(context: Context, manager: AppWidgetManager, ids: IntArray) =
    drawRows(context, manager, ids, RidikRowsFace.Kind.RINGS)

  override fun onAppWidgetOptionsChanged(
    context: Context,
    manager: AppWidgetManager,
    id: Int,
    options: Bundle?,
  ) = drawRows(context, manager, intArrayOf(id), RidikRowsFace.Kind.RINGS)
}

/**
 * People. Small and medium like Tasks, whose strip it borrows.
 */
class RidikPeopleWidgetProvider : AppWidgetProvider() {
  override fun onUpdate(context: Context, manager: AppWidgetManager, ids: IntArray) =
    drawRows(context, manager, ids, RidikRowsFace.Kind.PEOPLE)

  override fun onAppWidgetOptionsChanged(
    context: Context,
    manager: AppWidgetManager,
    id: Int,
    options: Bundle?,
  ) = drawRows(context, manager, intArrayOf(id), RidikRowsFace.Kind.PEOPLE)
}

/**
 * The week as seven cells. Small and medium — there is no eighth day for a
 * large tile to buy, so `drawnSize` folds one back rather than drawing the same
 * seven things taller.
 */
class RidikChainWidgetProvider : AppWidgetProvider() {
  override fun onUpdate(context: Context, manager: AppWidgetManager, ids: IntArray) =
    drawRows(context, manager, ids, RidikRowsFace.Kind.CHAIN)

  override fun onAppWidgetOptionsChanged(
    context: Context,
    manager: AppWidgetManager,
    id: Int,
    options: Bundle?,
  ) = drawRows(context, manager, intArrayOf(id), RidikRowsFace.Kind.CHAIN)
}

/**
 * The countdown. Small and medium — the face is one number, one title and one
 * place, and a large tile would be that with 300dp of ground under it.
 */
class RidikCountdownWidgetProvider : AppWidgetProvider() {
  override fun onUpdate(context: Context, manager: AppWidgetManager, ids: IntArray) =
    drawRows(context, manager, ids, RidikRowsFace.Kind.COUNTDOWN)

  override fun onAppWidgetOptionsChanged(
    context: Context,
    manager: AppWidgetManager,
    id: Int,
    options: Bundle?,
  ) = drawRows(context, manager, intArrayOf(id), RidikRowsFace.Kind.COUNTDOWN)
}

/**
 * Focus. Small and medium — the face is a clock, a label and a strip.
 */
class RidikFocusWidgetProvider : AppWidgetProvider() {
  override fun onUpdate(context: Context, manager: AppWidgetManager, ids: IntArray) =
    drawRows(context, manager, ids, RidikRowsFace.Kind.FOCUS)

  override fun onAppWidgetOptionsChanged(
    context: Context,
    manager: AppWidgetManager,
    id: Int,
    options: Bundle?,
  ) = drawRows(context, manager, intArrayOf(id), RidikRowsFace.Kind.FOCUS)
}

/**
 * The four rastered faces — Skyline, Sundial, Route and Term.
 *
 * Four classes for the same reason as every other one here: Android identifies a
 * widget by its provider class, and one class is one row in the picker. They
 * share `plotted`, which is where all four are actually drawn.
 */
class RidikHorizonWidgetProvider : AppWidgetProvider() {
  override fun onUpdate(context: Context, manager: AppWidgetManager, ids: IntArray) =
    drawRows(context, manager, ids, RidikRowsFace.Kind.HORIZON)

  override fun onAppWidgetOptionsChanged(
    context: Context,
    manager: AppWidgetManager,
    id: Int,
    options: Bundle?,
  ) = drawRows(context, manager, intArrayOf(id), RidikRowsFace.Kind.HORIZON)
}

class RidikSundialWidgetProvider : AppWidgetProvider() {
  override fun onUpdate(context: Context, manager: AppWidgetManager, ids: IntArray) =
    drawRows(context, manager, ids, RidikRowsFace.Kind.SUNDIAL)

  override fun onAppWidgetOptionsChanged(
    context: Context,
    manager: AppWidgetManager,
    id: Int,
    options: Bundle?,
  ) = drawRows(context, manager, intArrayOf(id), RidikRowsFace.Kind.SUNDIAL)
}

class RidikRouteWidgetProvider : AppWidgetProvider() {
  override fun onUpdate(context: Context, manager: AppWidgetManager, ids: IntArray) =
    drawRows(context, manager, ids, RidikRowsFace.Kind.ROUTE)

  override fun onAppWidgetOptionsChanged(
    context: Context,
    manager: AppWidgetManager,
    id: Int,
    options: Bundle?,
  ) = drawRows(context, manager, intArrayOf(id), RidikRowsFace.Kind.ROUTE)
}

class RidikTermWidgetProvider : AppWidgetProvider() {
  override fun onUpdate(context: Context, manager: AppWidgetManager, ids: IntArray) =
    drawRows(context, manager, ids, RidikRowsFace.Kind.TERM)

  override fun onAppWidgetOptionsChanged(
    context: Context,
    manager: AppWidgetManager,
    id: Int,
    options: Bundle?,
  ) = drawRows(context, manager, intArrayOf(id), RidikRowsFace.Kind.TERM)
}

/**
 * Draws one kind into every copy of it that is placed.
 *
 * Per widget id rather than once for all of them: the same face is a month plate
 * in one corner of the home screen and a plate over a strip over three rows in
 * another, and the layout variant is picked from the size the launcher reports
 * for that particular tile. `onAppWidgetOptionsChanged` is why this is reachable
 * from two directions — a resize has to re-pick the layout, not just redraw it.
 */
internal fun drawRows(
  context: Context,
  manager: AppWidgetManager,
  ids: IntArray,
  kind: RidikRowsFace.Kind,
) {
  for (id in ids) {
    val options = manager.getAppWidgetOptions(id)
    // Width and height both: `WIDGETS.md` §2 buckets on width first and then on
    // height, because a wide short tile and a wide tall one are different faces.
    val width = options?.getInt(AppWidgetManager.OPTION_APPWIDGET_MIN_WIDTH, 0) ?: 0
    val height = options?.getInt(AppWidgetManager.OPTION_APPWIDGET_MIN_HEIGHT, 0) ?: 0
    // `continue`, never `return`. One widget whose layout failed to resolve
    // must not skip every remaining id — that is one broken tile turning into
    // a home screen of stale ones.
    val views = RidikRowsFace.build(context, kind, width, height) ?: continue
    manager.updateAppWidget(id, views)
  }
}

/**
 * Pushes a redraw at every Ridik widget on the home screen.
 *
 * Called from the module after a snapshot lands. Nothing here broadcasts: the
 * caller is already off the main thread with the new payload committed, and
 * going through the system would only add a round trip before arriving back in
 * `onUpdate`. A kind with no placed copies costs one lookup and no drawing.
 */
internal object RidikWidgets {
  private val rowKinds = mapOf(
    RidikAgendaWidgetProvider::class.java to RidikRowsFace.Kind.AGENDA,
    RidikTasksWidgetProvider::class.java to RidikRowsFace.Kind.TASKS,
    RidikHabitsWidgetProvider::class.java to RidikRowsFace.Kind.HABITS,
    RidikListWidgetProvider::class.java to RidikRowsFace.Kind.LIST,
    RidikNowNextWidgetProvider::class.java to RidikRowsFace.Kind.NOWNEXT,
    RidikRingsWidgetProvider::class.java to RidikRowsFace.Kind.RINGS,
    RidikPeopleWidgetProvider::class.java to RidikRowsFace.Kind.PEOPLE,
    RidikChainWidgetProvider::class.java to RidikRowsFace.Kind.CHAIN,
    RidikCountdownWidgetProvider::class.java to RidikRowsFace.Kind.COUNTDOWN,
    RidikHorizonWidgetProvider::class.java to RidikRowsFace.Kind.HORIZON,
    RidikSundialWidgetProvider::class.java to RidikRowsFace.Kind.SUNDIAL,
    RidikRouteWidgetProvider::class.java to RidikRowsFace.Kind.ROUTE,
    RidikTermWidgetProvider::class.java to RidikRowsFace.Kind.TERM,
    RidikFocusWidgetProvider::class.java to RidikRowsFace.Kind.FOCUS,
  )

  fun redrawAll(context: Context) {
    val manager = AppWidgetManager.getInstance(context) ?: return
    RidikWidgetProvider.redrawAll(context)
    for ((provider, kind) in rowKinds) {
      val ids = manager.getAppWidgetIds(ComponentName(context, provider))
      if (ids.isEmpty()) continue
      drawRows(context, manager, ids, kind)
    }
  }
}
