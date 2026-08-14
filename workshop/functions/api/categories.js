// GET /api/categories —— 投稿分类元数据
import { publicJson, preflight } from "../_lib/util.js";
import { SCRIPT_CATEGORIES } from "../_lib/categories.js";

export const onRequestOptions = () => preflight();

export const onRequestGet = () => publicJson(
    { items: SCRIPT_CATEGORIES },
    { maxAge: 86400 }
);
