#!/bin/bash
# Health check script -- run at start of every loop iteration
# Customize for your setup: add checks for your bots, services, servers

# Check disk space
DISK_PCT=$(df -h / | awk 'NR==2 {print $5}' | tr -d '%')
if [ "$DISK_PCT" -gt 90 ]; then
    echo "[WARN] Disk: ${DISK_PCT}% used"
else
    echo "[OK] Disk: ${DISK_PCT}% used"
fi

# Check heartbeat freshness
if [ -f .heartbeat ]; then
    HB_AGE=$(($(date +%s) - $(date -d "$(cat .heartbeat)" +%s 2>/dev/null || echo 0)))
    if [ "$HB_AGE" -gt 600 ]; then
        echo "[WARN] Heartbeat: ${HB_AGE}s ago (stale)"
    else
        echo "[OK] Heartbeat: ${HB_AGE}s ago"
    fi
else
    echo "[WARN] Heartbeat: file missing"
fi

# Check if email service is reachable
if nc -z 127.0.0.1 1143 2>/dev/null; then
    echo "[OK] Email: IMAP reachable"
else
    echo "[WARN] Email: IMAP not reachable on port 1143"
fi

# Example: check a background process
# Uncomment and customize:
# if pgrep -f "my-bot.py" > /dev/null; then
#     echo "[OK] Bot: running (PID $(pgrep -f my-bot.py))"
# else
#     echo "[DEAD] Bot: not running"
# fi

# Example: check a web server
# if curl -s -o /dev/null -w "%{http_code}" http://localhost:8080 | grep -q "200"; then
#     echo "[OK] Web server: up"
# else
#     echo "[WARN] Web server: down"
# fi

echo ""
echo "HEALTH: Check complete"
