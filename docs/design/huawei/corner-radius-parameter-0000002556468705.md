# 圆角参数

圆角是UI设计中对矩形的直角边缘进行圆弧化处理的视觉规范，用于定义容器或控件的边角样式。

在视觉效果上，圆角能够带来一定的活力，并可以起到多种核心作用，包括软化界面锐利感、降低视觉压迫感，明确控件层级与边界，优化触控区域识别性，提升操作舒适度与可访问性，传递产品友好、专业、现代的品牌调性等。

通过设定圆角半径控制圆弧曲率，按控件层级设定固定半径，可以统一界面风格、提升视觉亲和力与触控体验，是现代设计系统的基础视觉属性。

## 圆角使用原则

圆角的分层构建与使用，核心是建立不同视觉层级间的有序关联，同时确保同一层级的圆角保持统一。

### 同层统一

为保障界面视觉秩序，同一功能层级、同一类型的控件或容器，需采用一致的圆角半径，避免视觉混乱。

|----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
|![](https://contentcenter-vali-drcn.dbankcdn.cn/pvt_2/DeveloperAlliance_scene_100_1/99/v3/rM4lTju0S7m98-oBxbiZ_A/zh-cn_image_0000002556777747.png?HW-CC-KV=V1&HW-CC-Date=20261008T155305Z&HW-CC-Expire=31536000000&HW-CC-Sign=18DFF7D03CEFA7FE95267BADB5C2DB6CBB71A252A9ECB0CDA73776C4FACD82DF "点击放大") ![](https://contentcenter-vali-drcn.dbankcdn.cn/pvt_2/DeveloperAlliance_scene_100_1/33/v3/WwMeA6ViQdi3BKhSPAPg7Q/zh-cn_image_0000002525777814.png?HW-CC-KV=V1&HW-CC-Date=20261008T155305Z&HW-CC-Expire=31536000000&HW-CC-Sign=8F5902BE8426535D177DA313C863891BD1F5693F8E3F84C70DD656CFD6AB9DD3 "点击放大") 推荐|![](https://contentcenter-vali-drcn.dbankcdn.cn/pvt_2/DeveloperAlliance_scene_100_1/3/v3/9Sqs156bSa-R5lT3woTH5w/zh-cn_image_0000002556897713.png?HW-CC-KV=V1&HW-CC-Date=20261008T155305Z&HW-CC-Expire=31536000000&HW-CC-Sign=9ED198D1D19F3ABE6990E1A4E87DFC2EA8FACC6DA6C6A20F6D90FDE8F5DA1A41 "点击放大") ![](https://contentcenter-vali-drcn.dbankcdn.cn/pvt_2/DeveloperAlliance_scene_100_1/41/v3/XQCTriQZR92H4y4deSFsMw/zh-cn_image_0000002525617872.png?HW-CC-KV=V1&HW-CC-Date=20261008T155305Z&HW-CC-Expire=31536000000&HW-CC-Sign=83091C98871E83F292787B10E423EB5534C1A8AF108C343ABB4A7B96C7BEB88F "点击放大") 不推荐|
|同一类型控件圆角相同|同一类型控件圆角不同|

### 层级正相关

圆角半径与界面元素的视觉、功能层级呈正相关，层级越高，圆角半径越大，例如半模态、弹出框等顶层元素圆角 > 图片、标签、角标等小控件，以此明确界面层级关系，提升视觉辨识度。

![](https://contentcenter-vali-drcn.dbankcdn.cn/pvt_2/DeveloperAlliance_scene_100_1/6c/v3/H6lzssOCQ0SNh6Zwmwr_QQ/zh-cn_image_0000002547781416.png?HW-CC-KV=V1&HW-CC-Date=20261008T155305Z&HW-CC-Expire=31536000000&HW-CC-Sign=DAF8D3CB333B4AE57CF6B29F8D895DBC3942882ACB1539A6569F514B564F5DC5 "点击放大")

## 通用圆角尺寸

HarmonyOS 视觉系统目前最常使用的圆角参数，广泛应用于图标、卡片、按钮、菜单、半模态、弹出框等场景。

|------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|------|--------------------|
|**圆角示意图**|**数值**|**场景**|
|![](https://contentcenter-vali-drcn.dbankcdn.cn/pvt_2/DeveloperAlliance_scene_100_1/4/v3/NXe_UAcCTOShhQBcUzWwlA/zh-cn_image_0000002525321714.png?HW-CC-KV=V1&HW-CC-Date=20261008T155305Z&HW-CC-Expire=31536000000&HW-CC-Sign=BC50050729A4AA34E66D79A804FEB8BEB19671ABD5C41504B27608F16DAD473F "点击放大")|4vp|系统通用超小圆角，适用于标签和角标等|
|![](https://contentcenter-vali-drcn.dbankcdn.cn/pvt_2/DeveloperAlliance_scene_100_1/86/v3/pMeLhgIDRL6NDcYnCOAeew/zh-cn_image_0000002525320292.png?HW-CC-KV=V1&HW-CC-Date=20261008T155305Z&HW-CC-Expire=31536000000&HW-CC-Sign=E1089884435506B1364B657C9EE35AFF63530F3D6DE475423B56262B496995B6 "点击放大")|8vp|系统通用小圆角，适用于各类图片和图标等|
|![](https://contentcenter-vali-drcn.dbankcdn.cn/pvt_2/DeveloperAlliance_scene_100_1/c8/v3/Zl-sC_YgShmf08qiBh6JsQ/zh-cn_image_0000002556521563.png?HW-CC-KV=V1&HW-CC-Date=20261008T155305Z&HW-CC-Expire=31536000000&HW-CC-Sign=8B9E21F0FD0774D5E00316ADEB1D1C129534AA8ACB8C8B70FF4A9088F8494023 "点击放大")|16vp|系统通用圆角，适用于通知卡片和内容容器等|
|![](https://contentcenter-vali-drcn.dbankcdn.cn/pvt_2/DeveloperAlliance_scene_100_1/42/v3/452b-s3gShqEvrXOZ5xBqg/zh-cn_image_0000002525481648.png?HW-CC-KV=V1&HW-CC-Date=20261008T155305Z&HW-CC-Expire=31536000000&HW-CC-Sign=F5BC7E0095422085E76DC9AC00F96C1F8C8D7F116CB06E6ACC3E99974BADA32E "点击放大")|20vp|系统通用大圆角，适用于按钮和菜单等|
|![](https://contentcenter-vali-drcn.dbankcdn.cn/pvt_2/DeveloperAlliance_scene_100_1/5b/v3/WV9J5DwaQjS2xA1yWiF0DQ/zh-cn_image_0000002556361597.png?HW-CC-KV=V1&HW-CC-Date=20261008T155305Z&HW-CC-Expire=31536000000&HW-CC-Sign=BEC3E8B2AECC44632C833A7434A3EC34FA46162D28622F182104653808DC3443 "点击放大")|32vp|系统通用超大圆角，适用于半模态和弹出框等|

## 通用圆角使用场景示例

### 系统通用超小圆角

4vp，适用于界面中尺寸较小、起到辅助标识作用的元素，用于弱化边缘锐利感，保持整体精致、紧凑的视觉效果。

典型场景：标签、角标、小型状态标识、迷你图标背景、细小型控件等。

![](https://contentcenter-vali-drcn.dbankcdn.cn/pvt_2/DeveloperAlliance_scene_100_1/7/v3/Ja6MjMAfTMGHEbNfmX_w8w/zh-cn_image_0000002556688061.png?HW-CC-KV=V1&HW-CC-Date=20261008T155305Z&HW-CC-Expire=31536000000&HW-CC-Sign=4DA33BE667E8F9FAAE08ED4FA012F639F422AE83DEDD371FAA69A4E5D08D8292 "点击放大")

### 系统通用小圆角

8vp，作为系统基础圆角，适用于各类常规展示类元素，保证视觉柔和、统一，是界面中使用频率较高的基础规格。

典型场景：各类图片、图标、小尺寸容器、列表内模块、基础功能控件等。

![](https://contentcenter-vali-drcn.dbankcdn.cn/pvt_2/DeveloperAlliance_scene_100_1/bd/v3/Fig_FKm4SuGUO22_xz3kUQ/zh-cn_image_0000002525528150.png?HW-CC-KV=V1&HW-CC-Date=20261008T155305Z&HW-CC-Expire=31536000000&HW-CC-Sign=2DED5960A4A0733C8AB2F0183B7EDDD6A0D8847973909948CF03D2A6CCC4924B "点击放大")

### 系统通用圆角

16vp，适用于需要突出信息、具备一定独立性的中层级容器与提示类组件，增强界面层次与可读性。

典型场景：通知卡片、普通卡片、内容容器、中型功能面板等。

![](https://contentcenter-vali-drcn.dbankcdn.cn/pvt_2/DeveloperAlliance_scene_100_1/59/v3/V1MfK33FQvKZMCFBM6qm2Q/zh-cn_image_0000002556568083.png?HW-CC-KV=V1&HW-CC-Date=20261008T155305Z&HW-CC-Expire=31536000000&HW-CC-Sign=90250F5E28B5FAC950E2CABF3D2E1885554E6CAE0FEAA76C9A7D597A6A27EBD2 "点击放大")

### 系统通用大圆角

20vp，适用于高频交互、需要清晰可点击感知的功能型元素，提升操作辨识度与友好度。

典型场景：按钮、菜单、选项卡、功能入口、常用交互控件等。

![](https://contentcenter-vali-drcn.dbankcdn.cn/pvt_2/DeveloperAlliance_scene_100_1/67/v3/31h_oJvJQC-Lia9NqW1N5w/zh-cn_image_0000002525368212.png?HW-CC-KV=V1&HW-CC-Date=20261008T155305Z&HW-CC-Expire=31536000000&HW-CC-Sign=37EEC45037859064460907DA5A322716AC92CF99CBB22908DC834E4D5EA64E58 "点击放大")

### 系统通用超大圆角

32vp，适用于高层级、强聚焦、占据较大视觉比重的弹出与半浮层类组件，强化层级感与现代感。

典型场景：半模态弹窗、大型弹出框、顶层浮层、重点展示容器等。

![](https://contentcenter-vali-drcn.dbankcdn.cn/pvt_2/DeveloperAlliance_scene_100_1/3a/v3/vRrYEmLFStquZaSP_3lC0Q/zh-cn_image_0000002525363476.png?HW-CC-KV=V1&HW-CC-Date=20261008T155305Z&HW-CC-Expire=31536000000&HW-CC-Sign=B806944E75A7B7718BA6B2A6E8E092C065D82362DF9BEA7055DE7835B7B2C0CA "点击放大")

## 系统圆角Token全量表

|---------------------|------|
|**Token**|**数值**|
|corner_radius_none|0|
|corner_radius_level1|2|
|corner_radius_level2|4|
|corner_radius_level3|6|
|corner_radius_level4|8|
|corner_radius_level5|10|
|corner_radius_level6|12|
|corner_radius_level7|14|
|corner_radius_level8|16|
|corner_radius_level9|18|
|corner_radius_level10|20|
|corner_radius_level11|22|
|corner_radius_level12|24|
|corner_radius_level13|26|
|corner_radius_level16|32|
|corner_radius_level18|36|

