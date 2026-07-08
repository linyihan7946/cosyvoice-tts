import json
import os
import sys


def emit(payload):
    print(json.dumps(payload, ensure_ascii=False))


def main():
    if len(sys.argv) < 3:
        emit({"sent": False, "sdk_available": False, "error": "phone and code are required"})
        return

    phone = sys.argv[1]
    code = sys.argv[2]

    try:
        from unisdk.exception import UniException
        from unisdk.sms import UniSMS
    except Exception as exc:
        emit({"sent": False, "sdk_available": False, "error": f"UniSMS SDK unavailable: {exc}"})
        return

    try:
        client = UniSMS(
            os.environ.get("SMS_ACCESS_KEY_ID"),
            os.environ.get("SMS_ACCESS_KEY_SECRET") or None,
        )
        res = client.send(
            {
                "to": phone,
                "signature": os.environ.get("SMS_SIGNATURE"),
                "templateId": os.environ.get("SMS_TEMPLATE_ID"),
                "templateData": {"code": code},
            }
        )

        data = getattr(res, "data", {}) or {}
        messages = data.get("messages") if isinstance(data, dict) else []
        statuses = [
            message.get("status")
            for message in messages
            if isinstance(message, dict) and message.get("status")
        ]
        sent = (
            getattr(res, "code", None) == "0"
            and (
                getattr(res, "message", None) == "Success"
                or data.get("code") == "OK"
                or any(status in {"sent", "delivered", "accepted"} for status in statuses)
            )
        )

        emit(
            {
                "sent": sent,
                "sdk_available": True,
                "code": getattr(res, "code", None),
                "message": getattr(res, "message", None),
                "data": data,
                "request_id": getattr(res, "request_id", None),
            }
        )
    except UniException as exc:
        emit(
            {
                "sent": False,
                "sdk_available": True,
                "error": str(exc),
                "code": getattr(exc, "code", None),
                "request_id": getattr(exc, "request_id", None),
            }
        )
    except Exception as exc:
        emit({"sent": False, "sdk_available": True, "error": str(exc)})


if __name__ == "__main__":
    main()
