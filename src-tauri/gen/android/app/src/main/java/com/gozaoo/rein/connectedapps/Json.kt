package com.gozaoo.rein.connectedapps

import org.json.JSONObject
import java.io.File
import java.time.Instant

/**
 * 桥文件 JSON 小工具：原子写 / 截断 / ISO 时间。
 *
 * 原子写与 Kotlin 其它桥一致：先写 `<name>.tmp` 再 renameTo；目标已存在时
 * renameTo 在部分文件系统上会失败，先删再改名。
 */
internal object Json {
    fun ok(data: JSONObject = JSONObject()): JSONObject =
        JSONObject().put("ok", true).put("data", data)

    fun err(code: String, message: String, action: String? = null): JSONObject {
        val error = JSONObject().put("code", code).put("message", message)
        if (action != null) error.put("action", action)
        return JSONObject().put("ok", false).put("error", error)
    }

    fun writeAtomic(file: File, value: JSONObject) {
        file.parentFile?.mkdirs()
        // 契约要求：先写 .part，再 rename；读到半截文件时 Rust 会按「还没好」重试。
        val tmp = File(file.parentFile, "${file.name}.part")
        tmp.writeText(value.toString())
        if (!tmp.renameTo(file)) {
            file.delete()
            tmp.renameTo(file)
        }
    }

    fun truncate(value: String?, max: Int): String = (value ?: "").take(max)

    fun isoNow(): String = Instant.now().toString()
}
