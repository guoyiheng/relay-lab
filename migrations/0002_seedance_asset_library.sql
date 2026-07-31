-- Seedance 虚拟人像库（asset://）接入
-- 控制面走 AK/SK 直连 BytePlus 海外（ark.<region>.byteplusapi.com，Action 式 OpenAPI），
-- 与生成用的 Bearer 中转是两套鉴权。素材入库拿 asset id → 生成时 content[] 用 asset://<id>
-- 引用，绕开实时真人检测。详见 pvpl.md。

-- 平台上存放素材库控制面凭证与缓存：
--   ark_access_key / ark_secret_key : 直连 BytePlus 的 AK/SK（仅 doubao-video 平台需要）
--   ark_region                      : 控制面 region（默认 ap-southeast-1）
--   ark_project_name                : 素材库项目隔离（须与生成 key 所属 project 一致，默认 default）
--   ark_asset_group_id              : 缓存该平台的 AIGC 素材组 id，避免每次 List/Create
ALTER TABLE providers ADD COLUMN ark_access_key TEXT;
ALTER TABLE providers ADD COLUMN ark_secret_key TEXT;
ALTER TABLE providers ADD COLUMN ark_region TEXT;
ALTER TABLE providers ADD COLUMN ark_project_name TEXT;
ALTER TABLE providers ADD COLUMN ark_asset_group_id TEXT;

-- 素材行缓存已入库的 asset id（幂等复用，避免同一素材重复上传）；Failed/过期时清空重建。
ALTER TABLE assets ADD COLUMN seedance_asset_id TEXT;
