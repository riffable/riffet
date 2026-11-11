import org.jetbrains.kotlin.gradle.dsl.JvmTarget

plugins {
    alias(libs.plugins.kotlinMultiplatform)
    alias(libs.plugins.kotlinSerialization)
    alias(libs.plugins.androidKotlinMultiplatformLibrary)
    alias(libs.plugins.composeMultiplatform)
    alias(libs.plugins.composeCompiler)
}

kotlin {
    // `jvm()` exists only so the network/auth/connection logic can be compiled and tested on a
    // machine with no Android SDK; the phone builds consume the same commonMain sources. It adds
    // no dependency the mobile targets do not already have.
    jvm()
    android {
        namespace = "riffet.shared"
        compileSdk = libs.versions.androidCompileSdk.get().toInt()
        minSdk = libs.versions.androidMinSdk.get().toInt()
        compilerOptions { jvmTarget.set(JvmTarget.JVM_17) }
        // Off by default in this plugin. `src/androidMain/res` holds the notification icon, which
        // the host module reads as `riffet.shared.R.drawable.ic_stat_riffet`.
        androidResources { enable = true }
    }
    iosArm64()
    iosSimulatorArm64()

    sourceSets {
        all { languageSettings.optIn("androidx.compose.ui.ExperimentalComposeUiApi") }
        commonMain.dependencies {
            // `api`: session state, the network layer and the presentation rules the screens render.
            api(project(":client"))
            // `api`: the DTOs returned by RiffetApi are declared in contracts.
            api(project(":contracts"))
            // `api`: the UI's entry points take TimelineItem and the projection helpers, so the host
            // modules that render them need `core` on their compile classpath too.
            api(project(":core"))
            // `api`: TerminalCanvas takes the engine's TerminalEmulator.
            api(project(":terminal"))
            // `api`: RiffetColors (riffet.theme) exposes Compose Color/TextUnit types, and
            // RiffetApi exposes HttpClient, so both must be visible to host modules.
            api(libs.compose.runtime)
            api(libs.compose.ui)
            // `api`: the UI screens are part of this module, and the Android host renders them.
            api(libs.compose.foundation)
            api(libs.compose.material3)
            implementation(libs.miuix.ui)
            // One source-backed material engine for every interface-style preset.
            implementation(libs.haze.core)
            implementation(libs.haze.blur)
            implementation(libs.haze.glass)
            implementation(libs.compose.ui.backhandler)
            api(libs.ktor.client.core)
            // `implementation`: the markdown renderer is an internal detail of
            // riffet/ui/timeline/. Nothing outside this module names its types — the transcript's
            // entry points still take Strings — so host modules must not see it on their compile
            // classpath. It also needs kotlinx-coroutines-core at runtime (its own metadata
            // declares coroutines as compileOnly); that is already a dependency below.
            implementation(libs.markdown.renderer)
            // The only image loader in the app (riffet/ui/timeline/TimelineImages.kt). `coil-compose`
            // is the Compose API; `coil-network-ktor3` is the Ktor 3 fetch component, so image
            // requests run on the same Ktor stack as every other request and can carry the device
            // token. Both cover Android + iOS + jvm from commonMain.
            implementation(libs.coil.compose)
            implementation(libs.coil.network.ktor3)
            // Compose Resources (`Res.string.*`), so user-visible copy lives in
            // composeResources/values(-en)/strings.xml instead of Kotlin literals.
            implementation(compose.components.resources)
            implementation(libs.kotlinx.coroutines.core)
            implementation(libs.kotlinx.serialization.json)
        }
        commonTest.dependencies {
            implementation(libs.kotlin.test)
            implementation(libs.kotlinx.coroutines.test)
            implementation(libs.ktor.client.mock)
        }
        // The JVM-only end-to-end SSE test needs a real engine: Ktor 3.1.3's MockEngine never
        // invokes the ResponseAdapter that turns a ByteReadChannel into an SSESession, so SSE can
        // only be exercised by an engine that does (CIO, OkHttp, Darwin). CIO is already pinned in
        // the catalog and is test-scoped here.
        jvmTest.dependencies {
            implementation(libs.compose.ui.test.junit4)
            // Pointer/retained-page tests render offscreen and need Skiko for the current host OS.
            implementation(compose.desktop.currentOs)
            implementation(libs.ktor.client.cio)
        }
        androidMain.dependencies {
            implementation(libs.androidx.appcompat)
            implementation(libs.androidx.core.ktx)
            implementation(libs.androidx.lifecycle.runtime.ktx)
            implementation(libs.woff2.decoder)
            // The engine behind the no-argument `HttpClient { }` factory on Android.
            implementation(libs.ktor.client.okhttp)
            // The QR pairing scanner lives in this source set (`riffet/shared/QrScanner.android.kt`),
            // because that is where the `expect fun createQrScanner()` of commonMain has to resolve.
            // `commonMain` never sees any of these types, and `androidApp` needs none of them on its
            // own compile classpath — it gets them at runtime through this module.
            implementation(libs.androidx.camera.core)
            implementation(libs.androidx.camera.camera2)
            implementation(libs.androidx.camera.lifecycle)
            implementation(libs.androidx.camera.view)
            implementation(libs.zxing.core)
            // `rememberLauncherForActivityResult`: the CAMERA permission is a runtime permission and
            // only an Activity-result launcher can ask for it from inside a composition. This is the
            // one dependency the scanner adds that is not the camera stack itself.
            implementation(libs.androidx.activity.compose)
        }
        iosMain.dependencies {
            // The engine behind the no-argument `HttpClient { }` factory on iOS.
            implementation(libs.ktor.client.darwin)
        }
    }
}
