"""Forward knowledge requests with the active account and pinned gateway TLS."""
from __future__ import annotations
import asyncio
import hashlib
import http.client
import re
from fastapi import Request
from fastapi.responses import Response
from .gateway import GatewayError

MAX_BODY = 60 * 1024 * 1024


def register_knowledge(app):
    @app.api_route('/api/knowledge/{route:path}', methods=['GET', 'POST', 'PATCH', 'DELETE'])
    async def knowledge(route: str, request: Request):
        if not re.fullmatch(r'[A-Za-z0-9_/-]{1,600}', route) or '..' in route:
            raise GatewayError('知识库地址无效', 400)
        gateway = request.app.state.runtime.gateway
        if not gateway.account_token:
            raise GatewayError('请先登录', 401)
        body = bytearray()
        async for part in request.stream():
            body.extend(part)
            if len(body) > MAX_BODY:
                raise GatewayError('PDF 文件过大，请选择小于 50 MB 的文件', 413)
        content = bytes(body)
        query = request.url.query
        if len(query) > 2048:
            raise GatewayError('知识库参数无效', 400)
        suffix = route + ('?' + query if query else '')
        path, _, headers = await gateway.request_parts(request.method, 'knowledge/' + suffix)
        headers.update({'Content-Type': request.headers.get('content-type', 'application/json'),
                        'Content-Length': str(len(content)), 'X-Shiyan-Body-Sha': hashlib.sha256(content).hexdigest()})
        connection = gateway.make_connection(timeout=250)
        gateway.open_connections.add(connection)

        def perform():
            connection.request(request.method, path, body=content or None, headers=headers)
            response = connection.getresponse()
            result = response.read(32 * 1024 * 1024 + 1)
            if len(result) > 32 * 1024 * 1024:
                raise GatewayError('知识库结果过大，请缩小查询范围', 502)
            return response.status, result

        try:
            status, result = await asyncio.to_thread(perform)
            return Response(result, status_code=status, media_type='application/json', headers={'Cache-Control': 'no-store'})
        except (OSError, http.client.HTTPException) as error:
            raise GatewayError('Mac 知识库暂时无法连接，请稍后重试', 503) from error
        finally:
            connection.close()
            gateway.open_connections.discard(connection)
