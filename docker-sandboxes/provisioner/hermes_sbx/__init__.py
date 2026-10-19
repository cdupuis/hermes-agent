"""Provision a Hermes Agent backend (`hermes serve`) in a Docker Cloud Sandbox.

The kit under ``../kit`` is packed into the inline v2 artifact the Sandboxes
API accepts (:mod:`hermes_sbx.kitpack`); :mod:`hermes_sbx.provision` drives
secret → volume → sandbox → port → login readout; :mod:`hermes_sbx.sdk` is the
one place that touches ``docker_sandboxes_api``.
"""
