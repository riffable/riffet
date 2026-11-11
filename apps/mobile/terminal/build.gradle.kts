import org.jetbrains.kotlin.gradle.dsl.JvmTarget

// The VT engine: a commonMain port of Termux's terminal-emulator (see NOTICE). No Compose, no
// platform API — the renderer and input live in :shared. `jvm()` is what runs its tests.
plugins {
    alias(libs.plugins.kotlinMultiplatform)
    alias(libs.plugins.androidKotlinMultiplatformLibrary)
}

kotlin {
    jvm()
    android {
        namespace = "riffet.terminal"
        compileSdk = libs.versions.androidCompileSdk.get().toInt()
        minSdk = libs.versions.androidMinSdk.get().toInt()
        compilerOptions { jvmTarget.set(JvmTarget.JVM_17) }
    }
    iosArm64()
    iosSimulatorArm64()

    sourceSets {
        commonTest.dependencies {
            implementation(libs.kotlin.test)
        }
        // TmuxParityTest reads the recorded fixtures (fixtures/tmux) from disk.
        jvmTest.dependencies {
            implementation(libs.kotlinx.serialization.json)
        }
    }
}

// Re-recorded fixtures must re-run the tests rather than reuse a cached result.
tasks.withType<Test>().configureEach {
    inputs.dir("fixtures").withPropertyName("fixtures")
}
