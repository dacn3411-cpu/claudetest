"""
국궁(각궁) 3D 모델을 Blender(bpy)로 만들어 GLB로 내보낸다.

  # Blender 4.2 파이썬 모듈 (Python 3.11): uv venv --python 3.11 venv && uv pip install --python venv/bin/python "bpy==4.2.*"
  venv/bin/python tools/bow/build_gakgung_blender.py   → public/assets/models/weapons/gakgung.glb
  (Blender가 없을 때는 node tools/bow/build_gakgung.mjs 로 같은 자리에 간단한 버전을 만들 수 있다)

각궁 특징을 따른 원래 디자인 (특정 사진을 베끼지 않음):
- 반곡(리커브): 줌통에서 뻗은 활 몸(오금)이 쏘는 사람 쪽으로 휘었다가, 끝의 고자가 과녁 쪽으로 다시 꺾인다
- 아랫장이 윗장보다 조금 길다
- 안쪽(쏘는 사람 쪽)은 윤이 나는 검은 물소뿔, 바깥쪽(과녁 쪽)은 화피(벚나무 껍질) 무늬
- 고자는 뽕나무 결, 가운데 줌통은 붉은 천을 감고 금색 띠, 시위가 걸치는 도고지, 끝의 양냥고자
텍스처 이미지는 코드로 만들어 GLB 안에 넣는다.

좌표(glTF 기준, 게임과 같음): 활 몸은 YZ 평면, +Y 위, 쏘는 사람 쪽 +Z, 과녁 쪽 -Z. 단위 m.
Blender는 Z가 위라서 glTF (x, y, z) → Blender (x, -z, y)로 놓는다 (내보낼 때 다시 바뀜).
게임이 시위·화살 자리를 찾는 빈 노드: string_top, string_bottom, bridge_top, bridge_bottom, arrow_rest, nock_point
"""

import math
import os
import random

import bpy  # bpy를 먼저 불러와야 bmesh를 쓸 수 있다

import bmesh

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.normpath(os.path.join(HERE, "..", "..", "public", "assets", "models", "weapons", "gakgung.glb"))
random.seed(7)


def B(x, y, z):
    """glTF 좌표 → Blender 좌표"""
    return (x, -z, y)


# ───────────────────────────── 장면 비우기 ─────────────────────────────
bpy.ops.wm.read_factory_settings(use_empty=True)


# ───────────────────────────── 텍스처 만들기 ─────────────────────────────
def make_image(name, w, h, pixel_fn):
    img = bpy.data.images.new(name, width=w, height=h, alpha=False)
    px = [0.0] * (w * h * 4)
    for j in range(h):
        for i in range(w):
            r, g, b = pixel_fn(i / w, j / h, i, j)
            k = (j * w + i) * 4
            px[k] = r
            px[k + 1] = g
            px[k + 2] = b
            px[k + 3] = 1.0
    img.pixels = px
    img.pack()
    return img


def srgb(hexstr):
    h = hexstr.lstrip("#")
    return tuple(int(h[i : i + 2], 16) / 255 for i in (0, 2, 4))


def mix(a, b, t):
    return tuple(a[i] + (b[i] - a[i]) * t for i in range(3))


BARK = srgb("#B5793F")
BARK_LIGHT = srgb("#D9A66A")
BARK_DARK = srgb("#5E3A1E")
# 화피: 길이 방향(u)으로 가로 껍질눈(가는 짙은 줄)과 은은한 띠
lenticels = [
    (random.random(), random.uniform(0.15, 0.85), random.uniform(0.004, 0.01), random.uniform(0.08, 0.3))
    for _ in range(140)
]


def bark_px(u, v, i, j):
    band = 0.5 + 0.5 * math.sin(u * 60 + math.sin(u * 11) * 2.5)
    c = mix(BARK, BARK_LIGHT, band * 0.45)
    for (lu, lv, lw, ll) in lenticels:
        if abs(u - lu) < lw and abs(v - lv) < ll * 0.5:
            c = mix(c, BARK_DARK, 0.75)
            break
    n = (math.sin(i * 12.9898 + j * 78.233) * 43758.5453) % 1.0
    return mix(c, BARK_DARK, n * 0.12)


GOJA = srgb("#E6CF98")
GOJA_DARK = srgb("#B8935A")


def goja_px(u, v, i, j):
    grain = 0.5 + 0.5 * math.sin(v * 40 + math.sin(u * 9) * 3 + math.sin(u * 31) * 0.6)
    return mix(GOJA, GOJA_DARK, grain * 0.35 + u * 0.25)


CLOTH = srgb("#9B1C1C")
CLOTH_DARK = srgb("#5E0F10")


def cloth_px(u, v, i, j):
    weave = ((i // 3) + (j // 3)) % 2
    diag = 0.5 + 0.5 * math.sin((u + v) * 90)
    return mix(CLOTH, CLOTH_DARK, 0.25 * weave + 0.15 * diag)


bark_img = make_image("hwapi_bark", 512, 64, bark_px)
goja_img = make_image("goja_wood", 256, 32, goja_px)
cloth_img = make_image("jumtong_cloth", 64, 64, cloth_px)


# ───────────────────────────── 재질 ─────────────────────────────
def material(name, color=None, image=None, rough=0.5, metal=0.0, clearcoat=0.0):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    nt = m.node_tree
    bsdf = nt.nodes["Principled BSDF"]
    if image is not None:
        tex = nt.nodes.new("ShaderNodeTexImage")
        tex.image = image
        nt.links.new(tex.outputs["Color"], bsdf.inputs["Base Color"])
    elif color is not None:
        bsdf.inputs["Base Color"].default_value = (*srgb(color), 1.0)
    bsdf.inputs["Roughness"].default_value = rough
    bsdf.inputs["Metallic"].default_value = metal
    if clearcoat > 0 and "Coat Weight" in bsdf.inputs:
        bsdf.inputs["Coat Weight"].default_value = clearcoat
    return m


M_HORN = material("mulso_horn", color="#141110", rough=0.22, clearcoat=0.6)
M_BARK = material("hwapi", image=bark_img, rough=0.62)
M_SIDE = material("limb_side", color="#3A2618", rough=0.55)
M_GOJA = material("goja", image=goja_img, rough=0.45)
M_CLOTH = material("jumtong_cloth", image=cloth_img, rough=0.9)
M_GOLD = material("gold", color="#E0B04A", rough=0.28, metal=0.9)
M_DOGOJI = material("dogoji", color="#5A1E14", rough=0.6)


# ───────────────────────────── 곡선 · 활 몸 ─────────────────────────────
def catmull(points, t):
    """균일 Catmull-Rom (양 끝은 끝점 반복). t=1이면 마지막 점"""
    n = len(points) - 1
    if t >= 1.0:
        return list(points[-1])
    seg = min(n - 1, int(t * n))
    lt = t * n - seg
    p0 = points[max(0, seg - 1)]
    p1 = points[seg]
    p2 = points[seg + 1]
    p3 = points[min(n, seg + 2)]
    out = []
    for k in range(3):
        a, b, c, d = p0[k], p1[k], p2[k], p3[k]
        out.append(
            0.5
            * (
                2 * b
                + (-a + c) * lt
                + (2 * a - 5 * b + 4 * c - d) * lt * lt
                + (-a + 3 * b - 3 * c + d) * lt * lt * lt
            )
        )
    return out


def sub(a, b):
    return [a[i] - b[i] for i in range(3)]


def norm(a):
    l = math.sqrt(sum(x * x for x in a)) or 1.0
    return [x / l for x in a]


def limb_mesh(name, pts, segments, width_at, thick_at, kind):
    """glTF 좌표 pts를 지나는 납작한 튜브. kind='limb'이면 안쪽 뿔/바깥 화피/옆면, 'goja'이면 고자 나무"""
    RING = 16
    me = bpy.data.meshes.new(name)
    obj = bpy.data.objects.new(name, me)
    bpy.context.collection.objects.link(obj)
    bm = bmesh.new()
    uv_layer = bm.loops.layers.uv.new("UVMap")
    rings = []
    for i in range(segments + 1):
        u = i / segments
        p = catmull(pts, u)
        q = catmull(pts, min(1.0, u + 0.002))
        q0 = catmull(pts, max(0.0, u - 0.002))
        T = norm(sub(q, q0))
        Bx = [1.0, 0.0, 0.0]
        N = norm([Bx[1] * T[2] - Bx[2] * T[1], Bx[2] * T[0] - Bx[0] * T[2], Bx[0] * T[1] - Bx[1] * T[0]])
        belly = 1 if N[2] >= 0 else -1
        w = width_at(u)
        t = thick_at(u)
        ring = []
        for j in range(RING):
            a = j / RING * math.pi * 2
            cx, cy = math.cos(a), math.sin(a)
            sx = math.copysign(abs(cx) ** 0.6, cx)
            sy = math.copysign(abs(cy) ** 0.6, cy)
            v = [p[k] + Bx[k] * sx * w * 0.5 + N[k] * sy * t * 0.5 for k in range(3)]
            vert = bm.verts.new(B(*v))
            ring.append((vert, sy * belly))
        rings.append(ring)
    bm.verts.ensure_lookup_table()
    mats = [M_HORN, M_BARK, M_SIDE] if kind == "limb" else [M_GOJA]
    for m in mats:
        obj.data.materials.append(m)
    for i in range(segments):
        for j in range(RING):
            j2 = (j + 1) % RING
            vs = [rings[i][j][0], rings[i][j2][0], rings[i + 1][j2][0], rings[i + 1][j][0]]
            f = bm.faces.new(vs)
            side = (rings[i][j][1] + rings[i][j2][1]) / 2
            if kind == "limb":
                f.material_index = 0 if side > 0.45 else (1 if side < -0.45 else 2)
            uvs = [
                (i / segments, j / RING),
                (i / segments, (j + 1) / RING),
                ((i + 1) / segments, (j + 1) / RING),
                ((i + 1) / segments, j / RING),
            ]
            for loop, uv in zip(f.loops, uvs):
                loop[uv_layer].uv = uv
    # 양 끝 막기
    for ring in (rings[0], rings[-1]):
        try:
            bm.faces.new([v for v, _ in ring])
        except ValueError:
            pass
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    bm.to_mesh(me)
    bm.free()
    for poly in me.polygons:
        poly.use_smooth = True
    sub_mod = obj.modifiers.new("smooth", "SUBSURF")
    sub_mod.levels = 1
    sub_mod.render_levels = 1
    return obj


def empty(name, gx, gy, gz):
    e = bpy.data.objects.new(name, None)
    e.location = B(gx, gy, gz)
    bpy.context.collection.objects.link(e)
    return e


def bevel(obj, width=0.002):
    m = obj.modifiers.new("bevel", "BEVEL")
    m.width = width
    m.segments = 2
    return obj


def build_arm(sign, length):
    s = lambda y: y * length * sign
    limb_pts = [
        [0, s(0.07), -0.012],
        [0, s(0.16), 0.004],
        [0, s(0.26), 0.035],
        [0, s(0.35), 0.072],
        [0, s(0.42), 0.1],
    ]
    limb_mesh(
        "wit-jang" if sign > 0 else "arae-jang",
        limb_pts,
        48,
        lambda u: 0.042 - u * 0.012,
        lambda u: 0.025 - u * 0.008,
        "limb",
    )
    goja_pts = [
        [0, s(0.41), 0.098],
        [0, s(0.47), 0.112],
        [0, s(0.525), 0.09],
        [0, s(0.565), 0.045],
        [0, s(0.585), -0.005],
    ]
    limb_mesh(
        "goja-top" if sign > 0 else "goja-bottom",
        goja_pts,
        32,
        lambda u: 0.032 - u * 0.012,
        lambda u: 0.024 - u * 0.009,
        "goja",
    )
    # 도고지 (시위 받침)
    bpy.ops.mesh.primitive_cube_add(size=1, location=B(0, s(0.43), 0.118))
    br = bpy.context.active_object
    br.name = "dogoji-top" if sign > 0 else "dogoji-bottom"
    br.scale = (0.036, 0.018, 0.016)  # Blender (x, y=-z방향, z=y방향)
    br.rotation_euler = (sign * 0.35, 0, 0)
    br.data.materials.append(M_DOGOJI)
    bevel(br, 0.08)
    # 오금·고자 이음매 금색 띠
    bpy.ops.mesh.primitive_torus_add(major_radius=0.02, minor_radius=0.004, location=B(0, s(0.41), 0.098))
    tor = bpy.context.active_object
    tor.rotation_euler = (sign * 0.6, 0, 0)
    tor.data.materials.append(M_GOLD)
    # 양냥고자 (시위 거는 끝)
    tip = goja_pts[-1]
    bpy.ops.mesh.primitive_uv_sphere_add(radius=0.011, location=B(*tip))
    sp = bpy.context.active_object
    sp.name = "yangnyang-top" if sign > 0 else "yangnyang-bottom"
    sp.data.materials.append(M_GOLD)
    bpy.ops.object.shade_smooth()
    empty("string_top" if sign > 0 else "string_bottom", tip[0], tip[1], tip[2] + 0.004)
    empty("bridge_top" if sign > 0 else "bridge_bottom", 0, s(0.43), 0.128)


build_arm(1, 1.0)
build_arm(-1, 1.06)  # 아랫장이 조금 길다

# 줌통: 붉은 천을 감은 손잡이 + 금색 띠 (Blender 원기둥은 Z축 = 활 길이 방향)
bpy.ops.mesh.primitive_cylinder_add(vertices=24, radius=0.02, depth=0.14, location=B(0, 0, -0.012))
grip = bpy.context.active_object
grip.name = "jumtong"
grip.scale = (1.15, 1.05, 1.0)
grip.data.materials.append(M_CLOTH)
bpy.ops.object.shade_smooth()
bevel(grip, 0.003)
for y in (-0.066, 0.066):
    bpy.ops.mesh.primitive_cylinder_add(vertices=24, radius=0.0215, depth=0.01, location=B(0, y, -0.012))
    band = bpy.context.active_object
    band.scale = (1.15, 1.05, 1.0)
    band.data.materials.append(M_GOLD)
    bpy.ops.object.shade_smooth()
    bevel(band, 0.002)
# 줌통 위 화살 자리 (가죽 덧댐)
bpy.ops.mesh.primitive_cube_add(size=1, location=B(0.02, 0.085, -0.012))
rest = bpy.context.active_object
rest.scale = (0.01, 0.03, 0.02)
rest.data.materials.append(M_DOGOJI)
bevel(rest, 0.1)

empty("arrow_rest", 0.012, 0.09, -0.012)
empty("nock_point", 0, 0.09, 0.128)

# 루트로 묶기
root = bpy.data.objects.new("gakgung", None)
bpy.context.collection.objects.link(root)
for o in list(bpy.context.collection.objects):
    if o is not root and o.parent is None:
        o.parent = root

os.makedirs(os.path.dirname(OUT), exist_ok=True)
bpy.ops.export_scene.gltf(
    filepath=OUT,
    export_format="GLB",
    export_apply=True,
    export_yup=True,
    export_image_format="AUTO",
)
print("wrote", OUT, os.path.getsize(OUT), "bytes")
