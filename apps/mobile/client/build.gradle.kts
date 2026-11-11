import org.jetbrains.kotlin.gradle.dsl.JvmTarget

// The Compose-free half of the client: session state, the device copy, the network layer and the
// pure presentation rules. `shared` builds the Compose UI on top of it; the macOS app consumes it
// from Swift through the RiffetKit framework (docs/MACOS.md, "Kotlin 侧改动").
plugins {
    alias(libs.plugins.kotlinMultiplatform)
    alias(libs.plugins.kotlinSerialization)
    alias(libs.plugins.androidKotlinMultiplatformLibrary)
    alias(libs.plugins.skie)
}

kotlin {
    jvm()
    android {
        namespace = "riffet.client"
        compileSdk = libs.versions.androidCompileSdk.get().toInt()
        minSdk = libs.versions.androidMinSdk.get().toInt()
        compilerOptions { jvmTarget.set(JvmTarget.JVM_17) }
    }
    iosArm64 {
        binaries.framework {
            baseName = "RiffetKit"
            isStatic = true
            export(project(":contracts"))
            export(project(":core"))
            binaryOption("bundleId", "io.github.riffetai.client")
        }
    }
    iosSimulatorArm64 {
        binaries.framework {
            baseName = "RiffetKit"
            isStatic = true
            export(project(":contracts"))
            export(project(":core"))
            binaryOption("bundleId", "io.github.riffetai.client")
        }
    }
    macosArm64 {
        binaries.framework {
            baseName = "RiffetKit"
            isStatic = true
            export(project(":contracts"))
            export(project(":core"))
        }
    }

    sourceSets {
        commonMain.dependencies {
            api(project(":contracts"))
            api(project(":core"))
            api(libs.ktor.client.core)
            api(libs.kotlinx.coroutines.core)
            api(libs.kotlinx.serialization.json)
        }
        commonTest.dependencies {
            implementation(libs.kotlin.test)
            implementation(libs.kotlinx.coroutines.test)
            implementation(libs.ktor.client.mock)
        }
        jvmTest.dependencies {
            implementation(libs.ktor.client.cio)
        }
        androidMain.dependencies {
            implementation(libs.ktor.client.okhttp)
        }
        appleMain.dependencies {
            implementation(libs.ktor.client.darwin)
        }
    }
}

// InteractionCardScenarioTest reads the scenarios the web port runs too (fixtures/interaction-card).
tasks.withType<Test>().configureEach {
    inputs.dir("fixtures").withPropertyName("fixtures")
}
