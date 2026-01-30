#!/usr/bin/env python3
# /// script
# requires-python = ">=3.11"
# dependencies = [
#     "morphcloud",
# ]
# ///
"""
scripts/create_base_snapshot.py

Creates the DBA base snapshot in Morph Cloud.

This script:
1. Creates a VM from the morphvm-minimal image
2. Uploads and runs the setup script
3. Verifies all services are working
4. Saves the VM as a reusable snapshot
5. Outputs the snapshot ID for configuration

Requirements:
- MORPH_API_KEY environment variable
- morphcloud Python package: pip install morphcloud
- setup_base_snapshot.sh in the same directory

Usage:
    export MORPH_API_KEY="morph_xxx..."
    python scripts/create_base_snapshot.py

Options:
    --dry-run       Show what would be done without executing
    --skip-verify   Skip service verification after setup
    --digest NAME   Custom digest name for the snapshot (default: dba-base-v1)
    --vcpus N       Number of vCPUs (default: 2)
    --memory MB     Memory in MB (default: 4096)
    --disk GB       Disk size in GB (default: 32)
"""

import os
import sys
import time
import argparse
import json
from pathlib import Path
from datetime import datetime

# Colors for terminal output
class Colors:
    RED = '\033[0;31m'
    GREEN = '\033[0;32m'
    YELLOW = '\033[1;33m'
    BLUE = '\033[0;34m'
    NC = '\033[0m'  # No Color

def log_info(msg):
    print(f"{Colors.GREEN}[INFO]{Colors.NC} {msg}")

def log_warn(msg):
    print(f"{Colors.YELLOW}[WARN]{Colors.NC} {msg}")

def log_error(msg):
    print(f"{Colors.RED}[ERROR]{Colors.NC} {msg}")

def log_step(step_num, total, msg):
    print(f"\n{Colors.BLUE}=== Step {step_num}/{total}: {msg} ==={Colors.NC}")


def check_requirements():
    """Check all requirements are met before proceeding."""
    errors = []

    # Check MORPH_API_KEY
    api_key = os.environ.get('MORPH_API_KEY')
    if not api_key:
        errors.append("MORPH_API_KEY environment variable not set")
    elif not api_key.startswith('morph_'):
        errors.append("MORPH_API_KEY should start with 'morph_'")

    # Check morphcloud package
    try:
        import morphcloud
        log_info("morphcloud package found")
    except ImportError:
        errors.append("morphcloud not installed. Run: pip install morphcloud")

    # Check setup script exists
    script_path = Path(__file__).parent / 'setup_base_snapshot.sh'
    if not script_path.exists():
        errors.append(f"Setup script not found: {script_path}")
    else:
        log_info(f"Setup script found: {script_path}")

    if errors:
        for error in errors:
            log_error(error)
        return False

    return True


def wait_for_instance_ready(instance, timeout=300):
    """Wait for instance to be ready with timeout."""
    log_info("Waiting for instance to be ready...")
    start_time = time.time()

    try:
        # Use the built-in wait_until_ready method
        instance.wait_until_ready(timeout=timeout)
        elapsed = time.time() - start_time
        log_info(f"Instance ready after {elapsed:.1f}s (status: {instance.status})")
        return True
    except Exception as e:
        elapsed = time.time() - start_time
        log_error(f"Instance not ready after {elapsed:.1f}s: {e}")
        return False


def run_setup_script(instance, script_path):
    """Upload and run the setup script on the instance."""
    log_info("Reading setup script...")
    with open(script_path, 'r') as f:
        script_content = f.read()

    # Upload script
    log_info("Uploading setup script to VM...")
    instance.exec(f"cat > /tmp/setup_base_snapshot.sh << 'ENDOFSCRIPT'\n{script_content}\nENDOFSCRIPT")
    instance.exec("chmod +x /tmp/setup_base_snapshot.sh")

    # Run the script
    log_info("Running setup script (this will take several minutes)...")
    log_info("Script output:")
    print("-" * 60)

    result = instance.exec("bash /tmp/setup_base_snapshot.sh 2>&1")
    print(result.stdout if hasattr(result, 'stdout') else str(result))
    print("-" * 60)

    # Check for the marker file
    check_result = instance.exec("cat /dba_base_snapshot_valid 2>/dev/null && echo 'VALID' || echo 'INVALID'")
    output = check_result.stdout if hasattr(check_result, 'stdout') else str(check_result)

    if 'VALID' in output:
        log_info("Setup script completed successfully")
        return True
    else:
        log_error("Setup script may have failed - marker file not found")
        return False


def verify_services(instance):
    """Verify all DBA services are running correctly."""
    log_info("Verifying services...")

    services = {
        'vncserver': 'systemctl is-active vncserver',
        'xfce-session': 'systemctl is-active xfce-session',
        'chrome-cdp': 'systemctl is-active chrome-cdp',
        'novnc': 'systemctl is-active novnc',
        'code-server': 'systemctl is-active code-server',
        'nginx': 'systemctl is-active nginx',
        'docker': 'systemctl is-active docker',
    }

    ports = {
        'VNC (5901)': 'nc -z localhost 5901 && echo "open" || echo "closed"',
        'noVNC (6080)': 'nc -z localhost 6080 && echo "open" || echo "closed"',
        'Chrome CDP (9222)': 'nc -z localhost 9222 && echo "open" || echo "closed"',
        'code-server (10080)': 'nc -z localhost 10080 && echo "open" || echo "closed"',
        'nginx (80)': 'nc -z localhost 80 && echo "open" || echo "closed"',
    }

    all_ok = True

    print("\nService Status:")
    for name, cmd in services.items():
        result = instance.exec(cmd)
        output = result.stdout.strip() if hasattr(result, 'stdout') else str(result).strip()
        if output == 'active':
            print(f"  {Colors.GREEN}[OK]{Colors.NC} {name}")
        else:
            print(f"  {Colors.RED}[FAIL]{Colors.NC} {name} ({output})")
            all_ok = False

    print("\nPort Status:")
    for name, cmd in ports.items():
        result = instance.exec(cmd)
        output = result.stdout.strip() if hasattr(result, 'stdout') else str(result).strip()
        if 'open' in output:
            print(f"  {Colors.GREEN}[OK]{Colors.NC} {name}")
        else:
            print(f"  {Colors.RED}[FAIL]{Colors.NC} {name}")
            all_ok = False

    # Check Chrome CDP specifically
    print("\nChrome CDP Check:")
    result = instance.exec('curl -s http://localhost:9222/json/version 2>/dev/null || echo "FAILED"')
    output = result.stdout if hasattr(result, 'stdout') else str(result)
    if 'Browser' in output:
        try:
            data = json.loads(output)
            print(f"  {Colors.GREEN}[OK]{Colors.NC} Chrome: {data.get('Browser', 'Unknown')}")
        except:
            print(f"  {Colors.GREEN}[OK]{Colors.NC} Chrome CDP responding")
    else:
        print(f"  {Colors.RED}[FAIL]{Colors.NC} Chrome CDP not responding")
        all_ok = False

    # Check Docker specifically
    print("\nDocker Check:")
    result = instance.exec('docker --version 2>/dev/null || echo "FAILED"')
    output = result.stdout if hasattr(result, 'stdout') else str(result)
    if 'Docker version' in output:
        print(f"  {Colors.GREEN}[OK]{Colors.NC} {output.strip()}")
    else:
        print(f"  {Colors.RED}[FAIL]{Colors.NC} Docker not responding")
        all_ok = False

    return all_ok


def main():
    parser = argparse.ArgumentParser(description='Create DBA base snapshot in Morph Cloud')
    parser.add_argument('--dry-run', action='store_true', help='Show what would be done')
    parser.add_argument('--skip-verify', action='store_true', help='Skip service verification')
    parser.add_argument('--digest', default='dba-base-v1', help='Snapshot digest name')
    parser.add_argument('--vcpus', type=int, default=2, help='Number of vCPUs')
    parser.add_argument('--memory', type=int, default=4096, help='Memory in MB')
    parser.add_argument('--disk', type=int, default=32, help='Disk size in GB')
    args = parser.parse_args()

    print("=" * 60)
    print("       DBA Base Snapshot Creator")
    print("=" * 60)
    print(f"\nStarted at: {datetime.now().isoformat()}")
    print(f"Configuration:")
    print(f"  Digest: {args.digest}")
    print(f"  vCPUs: {args.vcpus}")
    print(f"  Memory: {args.memory} MB")
    print(f"  Disk: {args.disk} GB")
    print()

    # Step 1: Check requirements
    log_step(1, 6, "Checking requirements")
    if not check_requirements():
        sys.exit(1)

    if args.dry_run:
        log_info("Dry run mode - would create snapshot with above configuration")
        sys.exit(0)

    # Import morphcloud after checking requirements
    from morphcloud.api import MorphCloudClient

    client = MorphCloudClient()
    instance = None

    try:
        # Step 2: Create VM from minimal image
        log_step(2, 6, "Creating VM from morphvm-minimal")

        log_info("Creating snapshot from base image...")
        snapshot = client.snapshots.create(
            image_id="morphvm-minimal",
            vcpus=args.vcpus,
            memory=args.memory,
            disk_size=args.disk * 1024  # Convert GB to MB
        )
        log_info(f"Initial snapshot created: {snapshot.id}")

        log_info("Starting instance from snapshot...")
        instance = client.instances.start(snapshot.id, ttl_seconds=7200)  # 2 hour TTL

        if not wait_for_instance_ready(instance):
            log_error("Failed to start instance")
            sys.exit(1)

        log_info(f"Instance started: {instance.id}")

        # Step 3: Upload and run setup script
        log_step(3, 6, "Running setup script")

        script_path = Path(__file__).parent / 'setup_base_snapshot.sh'
        if not run_setup_script(instance, script_path):
            log_warn("Setup script reported issues, continuing anyway...")

        # Step 4: Verify services
        log_step(4, 6, "Verifying services")

        if args.skip_verify:
            log_info("Skipping verification (--skip-verify)")
        else:
            # Wait a bit for services to stabilize
            log_info("Waiting 10 seconds for services to stabilize...")
            time.sleep(10)

            if not verify_services(instance):
                log_warn("Some services failed verification")
                response = input("\nContinue with snapshot creation anyway? (y/N): ")
                if response.lower() != 'y':
                    log_info("Aborting snapshot creation")
                    sys.exit(1)

        # Step 5: Save as snapshot
        log_step(5, 6, "Saving snapshot")

        log_info(f"Creating snapshot with digest: {args.digest}")
        base_snapshot = instance.snapshot(digest=args.digest)
        log_info(f"Snapshot created: {base_snapshot.id}")

        # Step 6: Cleanup and output
        log_step(6, 6, "Cleanup and summary")

        log_info("Stopping instance...")
        instance.stop()
        instance = None

        # Output results
        print("\n" + "=" * 60)
        print(f"{Colors.GREEN}       SUCCESS!{Colors.NC}")
        print("=" * 60)
        print()
        print(f"Base Snapshot ID: {base_snapshot.id}")
        print(f"Digest: {args.digest}")
        print()
        print("To use this snapshot:")
        print("  1. Add to your config:")
        print(f'     morph:')
        print(f'       base_snapshot_id: "{base_snapshot.id}"')
        print()
        print("  2. Or set environment variable:")
        print(f'     export DBA_BASE_SNAPSHOT="{base_snapshot.id}"')
        print()
        print("To test the snapshot:")
        print(f"  python -c \"")
        print(f"from morphcloud.api import MorphCloudClient")
        print(f"c = MorphCloudClient()")
        print(f"i = c.instances.start('{base_snapshot.id}', ttl_seconds=300)")
        print(f"i.wait_until_ready()")
        print(f"print('Instance:', i.id)")
        print(f"i.stop()\"")
        print()

        # Save snapshot info to file
        info_file = Path(__file__).parent / 'SNAPSHOT_INFO.txt'
        with open(info_file, 'w') as f:
            f.write("DBA Base Snapshot Information\n")
            f.write("=" * 40 + "\n")
            f.write(f"Created: {datetime.now().isoformat()}\n")
            f.write(f"Snapshot ID: {base_snapshot.id}\n")
            f.write(f"Digest: {args.digest}\n")
            f.write(f"Image Base: morphvm-minimal\n")
            f.write(f"Resources: {args.vcpus} vCPU, {args.memory}MB RAM, {args.disk}GB disk\n")
            f.write("\n")
            f.write("Services Included:\n")
            f.write("- Chrome with CDP (port 9222)\n")
            f.write("- TigerVNC (port 5901)\n")
            f.write("- noVNC (port 6080)\n")
            f.write("- code-server (port 10080)\n")
            f.write("- nginx (port 80)\n")
            f.write("- Docker (docker-ce, docker-compose)\n")
            f.write("- Devbox/Nix\n")

        log_info(f"Snapshot info saved to: {info_file}")

        print(f"\nCompleted at: {datetime.now().isoformat()}")

    except KeyboardInterrupt:
        log_warn("\nInterrupted by user")
        sys.exit(1)
    except Exception as e:
        log_error(f"Error: {e}")
        import traceback
        traceback.print_exc()
        sys.exit(1)
    finally:
        # Cleanup: stop instance if still running
        if instance is not None:
            try:
                log_info("Cleaning up: stopping instance...")
                instance.stop()
            except:
                pass


if __name__ == "__main__":
    main()
