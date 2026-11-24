plugins {
    kotlin("jvm") version "2.0.21"
    kotlin("plugin.serialization") version "2.0.21"
    application
}

repositories { mavenCentral() }

dependencies {
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-core:1.9.0")
    implementation("org.jetbrains.kotlinx:kotlinx-serialization-json:1.7.3")
    implementation("org.xerial:sqlite-jdbc:3.46.1.3")
    implementation("org.slf4j:slf4j-nop:2.0.16")
}

kotlin { jvmToolchain(17) }

application {
    mainClass.set("ocd.MainKt")
    applicationName = "ocd"
}
